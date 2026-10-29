import P from 'bluebird';
import notify from 'osg/notify';
import Image from 'osg/Image';
import Texture from 'osg/Texture';
import WebglCaps from 'osg/WebGLCaps';
import createKtx2Core from 'osgDB/ktx2/ktx2Core';
import ktx2Worker from 'osgDB/ktx2/ktx2Worker';
import getMscBasisTranscoder from 'osgDB/ktx2/mscBasisTranscoder';

//
// Reads KTX2 textures (https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html).
//
// Basis Universal payloads (ETC1S/BasisLZ and UASTC 4x4) are transcoded with the KTX-Software
// msc_basis_transcoder to whichever GPU format the context supports, preferring, in order,
// BC7/BPTC, ASTC 4x4, DXT/S3TC and ETC2, and falling back to plain RGBA32 when the context has
// none of the corresponding extensions.
//
// The transcoding itself runs in the worker pool of osgDB/ktx2/ktx2Worker, which is where the
// time goes: an 8192x8192 ETC1S texture takes a few hundred milliseconds to turn into BC7. The
// main thread only decides which target formats are acceptable, since that is the part that
// needs to know about the WebGL context, and turns the result into an osg.Image. When workers
// are unavailable or have been switched off, the same transcoding code runs here instead.
//
// KTX2 files holding an ordinary Vulkan format (vkFormat is not VK_FORMAT_UNDEFINED) need no
// transcoding and are sliced up on the main thread, as long as the format maps onto something
// WebGL can upload.
//
// A note on orientation: neither compressed blocks nor plain array data are affected by
// UNPACK_FLIP_Y_WEBGL, so the mipmaps are uploaded exactly as stored. That matches how the
// images coming out of the other loaders end up on the GPU, but it does mean a KTX2 file has to
// be authored with the same origin as the .png/.jpg it replaces (top left, which is what
// 'ktx create' writes unless told otherwise).
//

// The transcode targets we can pick from, most wanted first. nameOpaque, when set, is used
// instead for a source without an alpha channel. The names are the msc_basis_transcoder
// TranscodeTarget enumerators, resolved inside the worker.
// The sRGB variants of these GL formats are deliberately not used: the byte values then reach
// the shaders exactly like those of the .jpg/.png textures these files replace.
var TRANSCODE_TARGETS = [
    {
        extension: 'EXT_texture_compression_bptc',
        name: 'BC7_RGBA'
    },
    {
        extension: 'WEBGL_compressed_texture_astc',
        name: 'ASTC_4x4_RGBA'
    },
    {
        extension: 'WEBGL_compressed_texture_s3tc',
        name: 'BC3_RGBA',
        nameOpaque: 'BC1_RGB'
    },
    {
        extension: 'WEBGL_compressed_texture_etc',
        name: 'ETC2_RGBA',
        // ETC2 is backwards compatible with ETC1, so the transcoder's ETC1 output is a valid
        // COMPRESSED_RGB8_ETC2 payload
        nameOpaque: 'ETC1_RGB'
    }
];

// The GL format each transcode target ends up as
var GL_FORMAT_BY_TARGET_NAME = {
    BC7_RGBA: Texture.COMPRESSED_RGBA_BPTC_UNORM_EXT,
    ASTC_4x4_RGBA: Texture.COMPRESSED_RGBA_ASTC_4x4_KHR,
    BC3_RGBA: Texture.COMPRESSED_RGBA_S3TC_DXT5_EXT,
    BC1_RGB: Texture.COMPRESSED_RGB_S3TC_DXT1_EXT,
    ETC2_RGBA: Texture.COMPRESSED_RGBA8_ETC2_EAC,
    ETC1_RGB: Texture.COMPRESSED_RGB8_ETC2,
    RGBA32: Texture.RGBA
};

// Vulkan formats we can hand to WebGL as they are. The compressed ones additionally need the
// listed extension to be present.
var VK_FORMATS = {
    9: { format: Texture.LUMINANCE, bytesPerPixel: 1 }, // R8_UNORM
    15: { format: Texture.LUMINANCE, bytesPerPixel: 1 }, // R8_SRGB
    16: { format: Texture.LUMINANCE_ALPHA, bytesPerPixel: 2 }, // R8G8_UNORM
    22: { format: Texture.LUMINANCE_ALPHA, bytesPerPixel: 2 }, // R8G8_SRGB
    23: { format: Texture.RGB, bytesPerPixel: 3 }, // R8G8B8_UNORM
    29: { format: Texture.RGB, bytesPerPixel: 3 }, // R8G8B8_SRGB
    37: { format: Texture.RGBA, bytesPerPixel: 4 }, // R8G8B8A8_UNORM
    43: { format: Texture.RGBA, bytesPerPixel: 4 }, // R8G8B8A8_SRGB
    131: {
        format: Texture.COMPRESSED_RGB_S3TC_DXT1_EXT,
        extension: 'WEBGL_compressed_texture_s3tc'
    }, // BC1_RGB_UNORM_BLOCK
    133: {
        format: Texture.COMPRESSED_RGBA_S3TC_DXT1_EXT,
        extension: 'WEBGL_compressed_texture_s3tc'
    }, // BC1_RGBA_UNORM_BLOCK
    135: {
        format: Texture.COMPRESSED_RGBA_S3TC_DXT3_EXT,
        extension: 'WEBGL_compressed_texture_s3tc'
    }, // BC2_UNORM_BLOCK
    137: {
        format: Texture.COMPRESSED_RGBA_S3TC_DXT5_EXT,
        extension: 'WEBGL_compressed_texture_s3tc'
    }, // BC3_UNORM_BLOCK
    145: {
        format: Texture.COMPRESSED_RGBA_BPTC_UNORM_EXT,
        extension: 'EXT_texture_compression_bptc'
    }, // BC7_UNORM_BLOCK
    147: { format: Texture.COMPRESSED_RGB8_ETC2, extension: 'WEBGL_compressed_texture_etc' }, // ETC2_R8G8B8_UNORM_BLOCK
    151: { format: Texture.COMPRESSED_RGBA8_ETC2_EAC, extension: 'WEBGL_compressed_texture_etc' }, // ETC2_R8G8B8A8_UNORM_BLOCK
    157: {
        format: Texture.COMPRESSED_RGBA_ASTC_4x4_KHR,
        extension: 'WEBGL_compressed_texture_astc'
    } // ASTC_4x4_UNORM_BLOCK
};

// The container parsing and transcoding code, shared with the workers
var core = createKtx2Core();

// The mipmap entries Texture.generateMipmap and Texture.applyImage expect
var createMipmap = function(data, width, height) {
    return {
        data: data,
        width: width,
        height: height,
        getWidth: function() {
            return this.width;
        },
        getHeight: function() {
            return this.height;
        },
        getImage: function() {
            return this.data;
        }
    };
};

var hasExtension = function(name) {
    return !!WebglCaps.instance().getWebGLExtension(name);
};

// Warn about a given message only once, these are per file properties and models come with
// thousands of tiles
var warnedOnce = {};
var warnOnce = function(message) {
    if (warnedOnce[message]) return;
    warnedOnce[message] = true;
    notify.warn(message);
};

var describe = function(url) {
    return url ? ' (' + url + ')' : '';
};

// What this device ended up doing, for working out why a given GPU looks or performs the way
// it does. The transcoding happens in a worker, whose console is out of reach on a phone, so
// the outcome is reported from here instead. See getTranscodeStats.
var transcodeStats = {
    extensions: [],
    candidates: [],
    chosen: {}
};

/**
 * The transcode targets acceptable to this WebGL context, in the order we would like them.
 * @returns {Array} [ { name, nameOpaque } ], possibly empty, in which case RGBA32 is used
 */
var getTranscodeCandidates = function() {
    var candidates = [];
    var extensions = [];
    for (var i = 0; i < TRANSCODE_TARGETS.length; i++) {
        var candidate = TRANSCODE_TARGETS[i];
        if (!hasExtension(candidate.extension)) continue;
        extensions.push(candidate.extension);
        candidates.push({ name: candidate.name, nameOpaque: candidate.nameOpaque });
    }
    transcodeStats.extensions = extensions;
    transcodeStats.candidates = candidates;
    return candidates;
};

// Describes a candidate the way selectTarget will read it, i.e. showing both the name used for
// a source with an alpha channel and the one used for a source without
var describeCandidate = function(candidate) {
    return candidate.nameOpaque
        ? candidate.name + '/' + candidate.nameOpaque + ' (alpha/opaque)'
        : candidate.name;
};

// Reports, once per distinct target, what the transcoder actually produced
var reportTranscode = function(targetName) {
    if (targetName === undefined) return;

    var seen = transcodeStats.chosen[targetName];
    transcodeStats.chosen[targetName] = (seen || 0) + 1;
    if (seen !== undefined) return;

    var described = [];
    for (var i = 0; i < transcodeStats.candidates.length; i++) {
        described.push(describeCandidate(transcodeStats.candidates[i]));
    }

    // Deliberately at warn level rather than log: this fires at most once per format per
    // session, and it is the one thing you need when a device looks or performs unexpectedly.
    // Consumers turn the notify level down to WARN (swea does), which would swallow a log.
    var format = GL_FORMAT_BY_TARGET_NAME[targetName];
    console.info(
        'KTX2: transcoding to ' +
            targetName +
            (format !== undefined ? ' (GL 0x' + format.toString(16) + ')' : '') +
            ', offered [' +
            (described.join(', ') || 'nothing, no compressed texture extension') +
            ']'
    );
};

// vkFormat is set, so the payload is a plain Vulkan format we either can or cannot upload
var readUncompressedFormat = function(container, url) {
    var description = VK_FORMATS[container.vkFormat];
    if (description === undefined) {
        throw new Error('unsupported KTX2 vkFormat ' + container.vkFormat + describe(url));
    }
    if (description.extension !== undefined && !hasExtension(description.extension)) {
        throw new Error(
            'KTX2 vkFormat ' +
                container.vkFormat +
                describe(url) +
                ' needs the ' +
                description.extension +
                ' extension, which this context does not have'
        );
    }

    var levels = core.sliceLevels(container);

    // Catch a level that is not the tightly packed pyramid WebGL expects here rather than as an
    // opaque INVALID_VALUE at upload time
    if (description.bytesPerPixel !== undefined) {
        for (var level = 0; level < levels.length; level++) {
            var expected = levels[level].width * levels[level].height * description.bytesPerPixel;
            if (levels[level].data.length !== expected) {
                throw new Error(
                    'KTX2 level ' +
                        level +
                        describe(url) +
                        ' is ' +
                        levels[level].data.length +
                        ' bytes, expected ' +
                        expected +
                        ' for a tightly packed ' +
                        levels[level].width +
                        'x' +
                        levels[level].height +
                        ' image'
                );
            }
        }
    }

    return {
        width: container.pixelWidth,
        height: container.pixelHeight,
        targetName: undefined,
        format: description.format,
        levels: levels
    };
};

// Transcodes here rather than in a worker, used when workers are unavailable or switched off
var transcodeOnMainThread = function(container, candidates) {
    return getMscBasisTranscoder().then(function(transcoderModule) {
        var transcoded = core.transcode(transcoderModule, container, candidates);
        return {
            width: container.pixelWidth,
            height: container.pixelHeight,
            targetName: transcoded.targetName,
            levels: transcoded.levels
        };
    });
};

// Turns what the core or a worker produced into the shape Image.setImageCompressed wants
var toImageData = function(transcoded, url) {
    var format = GL_FORMAT_BY_TARGET_NAME[transcoded.targetName];
    if (transcoded.targetName !== undefined && format === undefined) {
        throw new Error(
            'the KTX2 transcoder produced ' +
                transcoded.targetName +
                describe(url) +
                ', which has no GL format mapped to it'
        );
    }

    reportTranscode(transcoded.targetName);

    var mipmaps = [];
    for (var level = 0; level < transcoded.levels.length; level++) {
        mipmaps.push(
            createMipmap(
                transcoded.levels[level].data,
                transcoded.levels[level].width,
                transcoded.levels[level].height
            )
        );
    }

    return {
        mipmaps: mipmaps,
        mipmapCount: mipmaps.length,
        width: transcoded.width,
        height: transcoded.height,
        format: format !== undefined ? format : transcoded.format,
        transcodedTo: transcoded.targetName
    };
};

/**
 * Reads the mipmap pyramid out of a .ktx2 buffer, transcoding it if needed.
 * @param {ArrayBuffer} arrayBuffer the whole .ktx2 file
 * @param {string} url (optional) used in log messages only
 * @returns {Promise} a promise resolving with
 *          { mipmaps, mipmapCount, width, height, format, transcodedTo }, ready to be handed to
 *          Image.setImageCompressed
 */
var readKTX2 = function(arrayBuffer, url) {
    var container;
    try {
        container = core.parse(arrayBuffer);
        if (container === undefined) {
            throw new Error('not a KTX2 file, the identifier does not match' + describe(url));
        }
        var problem = core.validate(container);
        if (problem !== undefined) {
            throw new Error('KTX2 ' + problem + describe(url));
        }
    } catch (error) {
        return P.reject(error);
    }

    if (container.orientation.length > 1 && container.orientation.charAt(1) === 'u') {
        warnOnce(
            'KTX2 texture ' +
                (url || '') +
                ' declares a bottom left origin (KTXorientation ' +
                container.orientation +
                '), which cannot be corrected on upload, so it will appear flipped'
        );
    }

    // A plain Vulkan format needs no transcoder, just the right GL enum
    if (container.vkFormat !== 0) {
        try {
            return P.resolve(toImageData(readUncompressedFormat(container, url), url));
        } catch (error) {
            return P.reject(error);
        }
    }

    var candidates = getTranscodeCandidates();
    var pool = ktx2Worker.instance();

    if (!pool.isAvailable()) {
        return transcodeOnMainThread(container, candidates).then(function(transcoded) {
            return toImageData(transcoded, url);
        });
    }

    return pool
        .transcode(arrayBuffer, candidates)
        .catch(function(error) {
            // The pool disables itself when its workers die, so retrying here lands on the
            // main thread rather than looping
            if (pool.isAvailable()) throw error;
            notify.warn(
                'transcoding ' + (url || 'a KTX2 texture') + ' on the main thread after: ' + error
            );
            return transcodeOnMainThread(container, candidates);
        })
        .then(function(transcoded) {
            return toImageData(transcoded, url);
        });
};

/**
 * Reads a .ktx2 buffer into an osg.Image.
 * @param {ArrayBuffer} arrayBuffer the whole .ktx2 file
 * @param {string} url (optional) the url the buffer came from, stored on the image
 * @returns {Promise} a promise resolving with the osg.Image
 */
var readImageKTX2 = function(arrayBuffer, url) {
    return readKTX2(arrayBuffer, url).then(function(data) {
        var image = new Image();
        if (url !== undefined) image.setURL(url);
        image.setImageCompressed(data);
        return image;
    });
};

/**
 * Starts the transcode workers ahead of the first .ktx2 texture, so that it does not have to
 * wait for the wasm module to compile. Calling this is optional.
 * @returns {Promise} a promise resolving with true once transcoding is ready, or with false if
 *          neither the workers nor the main thread could instantiate the transcoder
 */
var initKTX2 = function() {
    var pool = ktx2Worker.instance();
    if (pool.isAvailable()) {
        return pool.warmUp().then(function(ready) {
            if (ready) return true;
            return getMscBasisTranscoder().then(function() {
                return true;
            });
        });
    }

    return getMscBasisTranscoder().then(
        function() {
            return true;
        },
        function() {
            return false;
        }
    );
};

/**
 * Sets how many workers transcode KTX2 textures. 0 makes transcoding happen on the main thread.
 * The default is one less than the core count, capped at 4.
 * @param {number} count the number of workers
 */
var setWorkerCount = function(count) {
    ktx2Worker.instance().setWorkerCount(count);
};

/**
 * Terminates the transcode workers. They start again on the next .ktx2 texture.
 */
var terminateWorkers = function() {
    ktx2Worker.instance().terminate();
};

/**
 * @param {boolean} alpha whether the source has an alpha channel
 * @returns {string} the transcode target that would be used, for logging and debugging
 */
var getTranscodeTargetName = function(alpha) {
    var candidates = getTranscodeCandidates();
    if (candidates.length === 0) return core.FALLBACK_TARGET_NAME;
    return !alpha && candidates[0].nameOpaque ? candidates[0].nameOpaque : candidates[0].name;
};

/**
 * What this device offered and what the transcoder picked. Handy on a phone, where the console
 * of the transcode worker cannot be reached, and readable from the javascript console as
 * osgDB.KTX2Reader.getTranscodeStats().
 * @returns {Object} { extensions, candidates, chosen }, chosen counting textures per target
 */
var getTranscodeStats = function() {
    // Fill the candidates in even if nothing has been read yet
    if (transcodeStats.candidates.length === 0) getTranscodeCandidates();

    return {
        extensions: transcodeStats.extensions.slice(0),
        candidates: transcodeStats.candidates.slice(0),
        chosen: JSON.parse(JSON.stringify(transcodeStats.chosen))
    };
};

/**
 * The same thing as one line of text, for showing somewhere a console is not available.
 * @returns {string} a summary of the extensions, the candidates and what was picked
 */
var getTranscodeSummary = function() {
    var stats = getTranscodeStats();

    var described = [];
    for (var i = 0; i < stats.candidates.length; i++) {
        described.push(describeCandidate(stats.candidates[i]));
    }

    var used = [];
    for (var name in stats.chosen) {
        used.push(name + ' x' + stats.chosen[name]);
    }

    return (
        'KTX2 extensions [' +
        (stats.extensions.join(', ') || 'none') +
        '] candidates [' +
        (described.join(', ') || 'none') +
        '] used [' +
        (used.join(', ') || 'nothing yet') +
        ']'
    );
};

export default {
    read: readKTX2,
    readImage: readImageKTX2,
    init: initKTX2,
    setWorkerCount: setWorkerCount,
    terminateWorkers: terminateWorkers,
    getTranscodeTargetName: getTranscodeTargetName,
    getTranscodeStats: getTranscodeStats,
    getTranscodeSummary: getTranscodeSummary,
    getWorkerSource: ktx2Worker.getWorkerSource,
    core: core
};
