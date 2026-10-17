import P from 'bluebird';
import notify from 'osg/notify';
import createKtx2Core from 'osgDB/ktx2/ktx2Core';
import { MSC_BASIS_TRANSCODER_JS, decodeTranscoderWasm } from 'osgDB/ktx2/mscBasisTranscoder';

//
// A pool of web workers that transcode KTX2 Basis Universal payloads off the main thread.
//
// The workers are built from a Blob, whose source is three pieces of text glued together:
//
//   1. the emscripten glue of the KTX-Software transcoder, which is already carried around as
//      a string because the webpack version building OSG.js cannot parse it
//   2. createKtx2Core stringified, so the worker parses and transcodes with exactly the same
//      code the main thread fallback uses
//   3. workerMain stringified, the message loop below
//
// The wasm binary is not part of that source, it is sent to each worker in its init message.
//
// Callers should not use this module directly, osgDB/KTX2Reader picks between the pool and the
// main thread depending on what the browser supports and on setWorkerCount.
//

// How many workers to spin up when none has been requested explicitly. Transcoding is purely
// CPU bound, and it competes with whatever else the application runs in workers, so this stays
// well below the core count.
var DEFAULT_MAX_WORKER_COUNT = 4;

var getDefaultWorkerCount = function() {
    var cores = (window.navigator && window.navigator.hardwareConcurrency) || 2;
    return Math.max(1, Math.min(DEFAULT_MAX_WORKER_COUNT, cores - 1));
};

//
// The worker message loop. Stringified into the worker source, so like createKtx2Core its body
// must be self contained. The only things it may reach for are what the two other pieces of the
// worker source define: MSC_TRANSCODER and self.createKtx2Core.
//
// Note that the core is reached through self rather than by its imported name: the bundler
// rewrites references to an import binding, and that rewrite lands inside the text toString
// gives us, leaving the worker with an identifier that means nothing to it.
//
// Protocol, all replies carrying the id of the request they answer:
//   in   { type: 'init', id, wasmBinary }
//   out  { type: 'ready', id }
//   in   { type: 'transcode', id, buffer, candidates }
//   out  { type: 'result', id, width, height, targetName, levels: [ { width, height, buffer } ] }
//   out  { type: 'error', id, message }
//
// MSC_TRANSCODER comes from the emscripten glue prepended to the worker source, so it is not
// defined anywhere the linter can see it.
/*global MSC_TRANSCODER:false*/
var workerMain = function() {
    var core = self.createKtx2Core();
    var transcoderPromise;

    var fail = function(id, message) {
        self.postMessage({ type: 'error', id: id, message: message });
    };

    self.onmessage = function(event) {
        var message = event.data;

        if (message.type === 'init') {
            transcoderPromise = MSC_TRANSCODER({ wasmBinary: message.wasmBinary }).then(function(
                transcoderModule
            ) {
                transcoderModule.initTranscoders();
                return transcoderModule;
            });
            transcoderPromise.then(
                function() {
                    self.postMessage({ type: 'ready', id: message.id });
                },
                function(error) {
                    // Report an unusable worker rather than letting every request time out
                    fail(message.id, 'failed to instantiate the basis transcoder: ' + error);
                }
            );
            return;
        }

        if (message.type !== 'transcode') return;

        var id = message.id;
        if (transcoderPromise === undefined) {
            fail(id, 'the transcode worker was asked to transcode before being initialised');
            return;
        }

        transcoderPromise.then(
            function(transcoderModule) {
                var container;
                try {
                    container = core.parse(message.buffer);
                    if (container === undefined) {
                        fail(id, 'not a KTX2 file, the identifier does not match');
                        return;
                    }
                    var problem = core.validate(container);
                    if (problem !== undefined) {
                        fail(id, problem);
                        return;
                    }
                } catch (error) {
                    fail(id, 'failed parsing the KTX2 container: ' + error);
                    return;
                }

                var transcoded;
                try {
                    transcoded = core.transcode(transcoderModule, container, message.candidates);
                } catch (error) {
                    fail(id, error && error.message ? error.message : String(error));
                    return;
                }

                var levels = [];
                var transfers = [];
                for (var level = 0; level < transcoded.levels.length; level++) {
                    var transcodedLevel = transcoded.levels[level];
                    levels.push({
                        width: transcodedLevel.width,
                        height: transcodedLevel.height,
                        buffer: transcodedLevel.data.buffer
                    });
                    transfers.push(transcodedLevel.data.buffer);
                }

                self.postMessage(
                    {
                        type: 'result',
                        id: id,
                        width: container.pixelWidth,
                        height: container.pixelHeight,
                        targetName: transcoded.targetName,
                        levels: levels
                    },
                    transfers
                );
            },
            function(error) {
                fail(id, 'the basis transcoder is not available: ' + error);
            }
        );
    };
};

var workerSource;

/**
 * Builds the source of the transcode worker.
 * @returns {string} the worker source, ready to be wrapped in a Blob
 */
var getWorkerSource = function() {
    if (workerSource === undefined) {
        workerSource = [
            MSC_BASIS_TRANSCODER_JS,
            'self.createKtx2Core = ' + createKtx2Core.toString() + ';',
            '(' + workerMain.toString() + ')();'
        ].join('\n');
    }
    return workerSource;
};

/**
 * @returns {boolean} true if this browser can run the transcode workers at all
 */
var isWorkerSupported = function() {
    return (
        typeof window.Worker === 'function' &&
        typeof window.Blob === 'function' &&
        typeof window.URL !== 'undefined' &&
        typeof window.URL.createObjectURL === 'function'
    );
};

var Ktx2WorkerPool = function() {
    this._workers = [];
    this._pending = {};
    this._nextRequestId = 1;
    this._workerCount = undefined;
    this._objectUrl = undefined;
    this._disabled = false;
};

Ktx2WorkerPool.prototype = {
    /**
     * Sets how many workers the pool runs. 0 disables the pool, which makes KTX2Reader
     * transcode on the main thread instead. Takes effect on the next transcode.
     * @param {number} count the number of workers
     */
    setWorkerCount: function(count) {
        var wanted = Math.max(0, count | 0);
        if (wanted === this._workerCount) return;
        this._workerCount = wanted;
        this.terminate();
    },

    getWorkerCount: function() {
        return this._workerCount === undefined ? getDefaultWorkerCount() : this._workerCount;
    },

    /**
     * @returns {boolean} true if a transcode request would be handled by a worker
     */
    isAvailable: function() {
        return !this._disabled && this.getWorkerCount() > 0 && isWorkerSupported();
    },

    /**
     * Terminates every worker and rejects whatever was still in flight. The pool spins back up
     * on the next transcode.
     */
    terminate: function() {
        for (var i = 0; i < this._workers.length; i++) {
            this._workers[i].worker.terminate();
            this._workers[i].resolveReady(false);
        }
        this._workers.length = 0;

        if (this._objectUrl !== undefined) {
            window.URL.revokeObjectURL(this._objectUrl);
            this._objectUrl = undefined;
        }

        var pending = this._pending;
        this._pending = {};
        for (var id in pending) {
            pending[id].reject(new Error('the KTX2 transcode workers were terminated'));
        }
    },

    _handleMessage: function(entry, event) {
        var message = event.data;

        if (message.type === 'ready') {
            entry.resolveReady(true);
            return;
        }

        var request = this._pending[message.id];
        if (request === undefined) {
            // An error reported outside of any request, i.e. a worker that failed to
            // instantiate the transcoder. Drop it from the pool so it stops taking work.
            if (message.type === 'error') {
                notify.warn('a KTX2 transcode worker is unusable: ' + message.message);
                this._dropWorker(entry);
            }
            return;
        }

        delete this._pending[message.id];
        entry.outstanding--;

        if (message.type === 'error') {
            request.reject(new Error(message.message));
            return;
        }

        var levels = [];
        for (var level = 0; level < message.levels.length; level++) {
            var transferredLevel = message.levels[level];
            levels.push({
                width: transferredLevel.width,
                height: transferredLevel.height,
                data: new Uint8Array(transferredLevel.buffer)
            });
        }

        request.resolve({
            width: message.width,
            height: message.height,
            targetName: message.targetName,
            levels: levels
        });
    },

    _dropWorker: function(entry) {
        var index = this._workers.indexOf(entry);
        if (index === -1) return;
        this._workers.splice(index, 1);
        entry.worker.terminate();
        entry.resolveReady(false);

        // Requests this worker was chewing on will never be answered
        for (var id in this._pending) {
            if (this._pending[id].entry === entry) {
                var request = this._pending[id];
                delete this._pending[id];
                request.reject(new Error('the KTX2 transcode worker handling this request died'));
            }
        }

        if (this._workers.length === 0) {
            // Nothing left to fall back on but the main thread
            this._disabled = true;
            notify.warn('all KTX2 transcode workers failed, transcoding on the main thread');
        }
    },

    _createWorkers: function() {
        var source = getWorkerSource();
        this._objectUrl = window.URL.createObjectURL(
            new window.Blob([source], { type: 'text/javascript' })
        );

        var wasmBinary = decodeTranscoderWasm();
        var count = this.getWorkerCount();
        for (var i = 0; i < count; i++) {
            this._workers.push(this._createWorker(wasmBinary));
        }
    },

    _createWorker: function(wasmBinary) {
        var worker = new window.Worker(this._objectUrl);
        var entry = { worker: worker, outstanding: 0, resolveReady: undefined, ready: undefined };
        entry.ready = new P(function(resolve) {
            // Resolved with true on the worker's ready message, false if the worker is dropped
            entry.resolveReady = resolve;
        });

        worker.onmessage = this._handleMessage.bind(this, entry);
        worker.onerror = this._handleWorkerError.bind(this, entry);

        // Every worker gets its own copy of the binary, the wasm module it instantiates is not
        // shareable. id 0 is reserved for messages that answer no transcode request.
        worker.postMessage({ type: 'init', id: 0, wasmBinary: wasmBinary });

        return entry;
    },

    /**
     * Builds the workers, if they are not up already, and waits for their transcoder.
     * @returns {Promise} a promise resolving with true if at least one worker came up
     */
    warmUp: function() {
        if (!this.isAvailable()) return P.resolve(false);

        if (this._workers.length === 0) {
            try {
                this._createWorkers();
            } catch (error) {
                this._disabled = true;
                notify.warn('could not start the KTX2 transcode workers: ' + error);
                return P.resolve(false);
            }
        }

        var readyPromises = [];
        for (var i = 0; i < this._workers.length; i++) {
            readyPromises.push(this._workers[i].ready);
        }

        return P.all(readyPromises).then(function(results) {
            for (var result = 0; result < results.length; result++) {
                if (results[result]) return true;
            }
            return false;
        });
    },

    _handleWorkerError: function(entry, event) {
        notify.error(
            'a KTX2 transcode worker raised an error: ' +
                (event && event.message ? event.message : event)
        );
        this._dropWorker(entry);
    },

    /**
     * Transcodes a .ktx2 buffer on one of the workers.
     * @param {ArrayBuffer} arrayBuffer the whole .ktx2 file
     * @param {Array} candidates [ { name, nameOpaque } ] transcode targets in priority order
     * @returns {Promise} a promise resolving with
     *          { width, height, targetName, levels: [ { width, height, data } ] }
     */
    transcode: function(arrayBuffer, candidates) {
        if (this._workers.length === 0) {
            try {
                this._createWorkers();
            } catch (error) {
                this._disabled = true;
                notify.warn(
                    'could not start the KTX2 transcode workers, transcoding on the main' +
                        ' thread instead: ' +
                        error
                );
                return P.reject(error);
            }
        }

        // Least busy worker, transcoding a level is long enough that round robin would leave
        // workers idle behind a big texture
        var entry = this._workers[0];
        for (var i = 1; i < this._workers.length; i++) {
            if (this._workers[i].outstanding < entry.outstanding) entry = this._workers[i];
        }

        var id = this._nextRequestId++;
        var pending = this._pending;
        var promise = new P(function(resolve, reject) {
            pending[id] = { resolve: resolve, reject: reject, entry: entry };
        });

        entry.outstanding++;
        // The buffer is copied rather than transferred: it belongs to the caller, which may
        // well read the same untarred file again for another texture of the same model.
        entry.worker.postMessage({
            type: 'transcode',
            id: id,
            buffer: arrayBuffer,
            candidates: candidates
        });

        return promise;
    }
};

var pool = new Ktx2WorkerPool();

export default {
    instance: function() {
        return pool;
    },
    getWorkerSource: getWorkerSource,
    isWorkerSupported: isWorkerSupported,
    // exposed so that a test can drive the real worker source with a stand in for self,
    // browsers being the only place a genuine Worker can be created
    workerMain: workerMain
};
