import P from 'bluebird';
import notify from 'osg/notify';
import {
    MSC_BASIS_TRANSCODER_JS,
    MSC_BASIS_TRANSCODER_WASM_BASE64
} from 'osgDB/ktx2/mscBasisTranscoderInlined';

//
// Loads the KTX-Software msc_basis_transcoder wasm module on the main thread.
//
// Both the emscripten glue and the wasm binary are inlined in
// mscBasisTranscoderInlined.js (see generateInlined.js for why), so nothing is fetched
// from the network and no extra asset has to be deployed next to OSG.js.
//
// Transcoding normally happens in the workers of osgDB/ktx2/ktx2Worker, which build their
// source from MSC_BASIS_TRANSCODER_JS and get their wasm from decodeTranscoderWasm. What is
// exported here is the main thread fallback, used when workers are unavailable or disabled.
//

var decodeBase64 = function(base64) {
    // atob gives us one byte per code unit, which we then copy into a real byte array
    var binary = window.atob(base64);
    var length = binary.length;
    var bytes = new Uint8Array(length);
    for (var i = 0; i < length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};

// The MSC_TRANSCODER factory, created once from the inlined glue code
var factory;

var getFactory = function() {
    if (factory === undefined) {
        // The glue code cannot be parsed by the webpack version building OSG.js, so it is
        // carried around as a string and evaluated here. Note that the transcoder needs
        // 'unsafe-eval' anyway: embind builds its method invokers with new Function.
        //
        // 'process' and 'require' are shadowed with undefined so that the glue always picks
        // its web branch. Without that it takes the node branch when osgjs runs under node
        // (unit tests, server side use) and then fails on require('fs'), which is not in scope
        // inside a new Function body.
        /*jshint evil: true */
        factory = new Function(
            'process',
            'require',
            MSC_BASIS_TRANSCODER_JS + '\nreturn MSC_TRANSCODER;'
        )(undefined, undefined);
        /*jshint evil: false */
    }
    return factory;
};

// The decoded wasm binary, kept so that spinning up a worker does not decode it again
var wasmBinary;

/**
 * Decodes the inlined wasm binary, once per session.
 * @returns {Uint8Array} the wasm module bytes
 */
var decodeTranscoderWasm = function() {
    if (wasmBinary === undefined) {
        wasmBinary = decodeBase64(MSC_BASIS_TRANSCODER_WASM_BASE64);
    }
    return wasmBinary;
};

// Promise of the instantiated module, shared by every caller
var modulePromise;

/**
 * Instantiates the msc_basis_transcoder module, at most once per session.
 * @returns {Promise} a promise resolving with the emscripten module.
 */
var getMscBasisTranscoder = function() {
    if (modulePromise === undefined) {
        modulePromise = P.resolve()
            .then(function() {
                return getFactory()({ wasmBinary: decodeTranscoderWasm() });
            })
            .then(function(transcoderModule) {
                transcoderModule.initTranscoders();
                return transcoderModule;
            })
            .catch(function(error) {
                notify.error('failed to instantiate the basis transcoder: ' + error);
                // let every later call retry rather than caching the failure forever
                modulePromise = undefined;
                throw error;
            });
    }
    return modulePromise;
};

export default getMscBasisTranscoder;
export { MSC_BASIS_TRANSCODER_JS, decodeTranscoderWasm };
