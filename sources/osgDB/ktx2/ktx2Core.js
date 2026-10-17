//
// KTX2 container parsing and Basis Universal transcoding.
//
// The container format is described at
// https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html
//
// IMPORTANT: everything below lives inside createKtx2Core, and the body of that function must
// stay self contained: no imports, no references to anything in module scope, no notify. The
// function is stringified into the source of the transcode worker (see ktx2Worker.js) as well
// as called directly on the main thread, so that both run exactly the same code. Nothing in
// here touches WebGL or the DOM either, which is what makes it usable from a worker.
//
// The division of labour with osgDB/KTX2Reader is that this file never looks at GL enums or at
// which extensions the context supports. Candidate transcode targets arrive by name and the
// name of the one that was used is reported back.
//

var createKtx2Core = function() {
    var KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

    // supercompressionScheme values
    var SUPERCOMPRESSION_NONE = 0;
    var SUPERCOMPRESSION_BASIS_LZ = 1;

    var SUPERCOMPRESSION_NAMES = {
        0: 'none',
        1: 'BasisLZ',
        2: 'Zstandard',
        3: 'ZLIB'
    };

    // khr_df_model_e values we care about
    var COLOR_MODEL_ETC1S = 163;
    var COLOR_MODEL_UASTC = 166;

    // khr_df_transfer_e values
    var TRANSFER_LINEAR = 1;

    // khr_df_channel_etc1s_e / khr_df_channel_uastc_e values
    var CHANNEL_ETC1S_AAA = 15;
    var CHANNEL_UASTC_RGBA = 3;

    var VK_FORMAT_UNDEFINED = 0;

    // The fallback target, always available, plain 8 bit RGBA
    var FALLBACK_TARGET_NAME = 'RGBA32';

    // Reads a 64 bit little endian value as a double. Everything the container stores as 64 bit
    // (offsets and lengths inside the file) is far below 2^53 in practice.
    var getUint64 = function(dataView, offset) {
        var low = dataView.getUint32(offset, true);
        var high = dataView.getUint32(offset + 4, true);
        return high * 4294967296 + low;
    };

    var hasIdentifier = function(bytes) {
        if (bytes.length < KTX2_IDENTIFIER.length) return false;
        for (var i = 0; i < KTX2_IDENTIFIER.length; i++) {
            if (bytes[i] !== KTX2_IDENTIFIER[i]) return false;
        }
        return true;
    };

    // Basic data format descriptor block, see
    // https://registry.khronos.org/DataFormat/specs/1.3/dataformat.1.3.html
    var parseDataFormatDescriptor = function(dataView, byteOffset, byteLength) {
        var dfd = {
            colorModel: 0,
            colorPrimaries: 0,
            transferFunction: TRANSFER_LINEAR,
            flags: 0,
            samples: []
        };

        // 4 bytes of total size, then a 24 byte basic block header, then 16 bytes per sample
        if (byteLength < 4 + 24) return dfd;

        var offset = byteOffset + 4;
        // vendorId + descriptorType, then versionNumber + descriptorBlockSize
        offset += 4;
        var versionAndBlockSize = dataView.getUint32(offset, true);
        var descriptorBlockSize = versionAndBlockSize >>> 16;
        offset += 4;

        var modelAndTransfer = dataView.getUint32(offset, true);
        dfd.colorModel = modelAndTransfer & 0xff;
        dfd.colorPrimaries = (modelAndTransfer >>> 8) & 0xff;
        dfd.transferFunction = (modelAndTransfer >>> 16) & 0xff;
        dfd.flags = (modelAndTransfer >>> 24) & 0xff;
        offset += 4;

        // texelBlockDimension0..3 then bytesPlane0..7
        offset += 4 + 8;

        var sampleCount = Math.floor((descriptorBlockSize - 24) / 16);
        for (var i = 0; i < sampleCount; i++) {
            var bitOffsetAndLength = dataView.getUint32(offset, true);
            dfd.samples.push({
                bitOffset: bitOffsetAndLength & 0xffff,
                bitLength: ((bitOffsetAndLength >>> 16) & 0xff) + 1,
                channelType: (bitOffsetAndLength >>> 24) & 0x0f,
                qualifiers: (bitOffsetAndLength >>> 28) & 0x0f
            });
            offset += 16;
        }

        return dfd;
    };

    // Key/value data, a list of 4 byte aligned (uint32 length, nul terminated key, value)
    // records. Values are kept as strings, the keys KTX2 defines are all textual.
    var parseKeyValueData = function(bytes, dataView, byteOffset, byteLength) {
        var keyValue = {};
        var offset = byteOffset;
        var end = byteOffset + byteLength;

        while (offset + 4 <= end) {
            var length = dataView.getUint32(offset, true);
            offset += 4;
            if (length === 0 || offset + length > end) break;

            var keyEnd = offset;
            while (keyEnd < offset + length && bytes[keyEnd] !== 0) keyEnd++;

            var key = '';
            for (var i = offset; i < keyEnd; i++) key += String.fromCharCode(bytes[i]);

            var value = '';
            for (var j = keyEnd + 1; j < offset + length && bytes[j] !== 0; j++) {
                value += String.fromCharCode(bytes[j]);
            }
            keyValue[key] = value;

            offset += length;
            offset += (4 - offset % 4) % 4;
        }

        return keyValue;
    };

    // BasisLZ supercompression global data: a header, one image descriptor per image and then
    // the shared endpoint/selector/table payloads.
    var parseBasisLzGlobalData = function(bytes, dataView, byteOffset, imageCount) {
        var offset = byteOffset;
        var globalData = {
            endpointCount: dataView.getUint16(offset, true),
            selectorCount: dataView.getUint16(offset + 2, true),
            endpointsByteLength: dataView.getUint32(offset + 4, true),
            selectorsByteLength: dataView.getUint32(offset + 8, true),
            tablesByteLength: dataView.getUint32(offset + 12, true),
            extendedByteLength: dataView.getUint32(offset + 16, true),
            imageDescs: []
        };
        offset += 20;

        for (var i = 0; i < imageCount; i++) {
            globalData.imageDescs.push({
                imageFlags: dataView.getUint32(offset, true),
                rgbSliceByteOffset: dataView.getUint32(offset + 4, true),
                rgbSliceByteLength: dataView.getUint32(offset + 8, true),
                alphaSliceByteOffset: dataView.getUint32(offset + 12, true),
                alphaSliceByteLength: dataView.getUint32(offset + 16, true)
            });
            offset += 20;
        }

        globalData.endpoints = bytes.subarray(offset, offset + globalData.endpointsByteLength);
        offset += globalData.endpointsByteLength;
        globalData.selectors = bytes.subarray(offset, offset + globalData.selectorsByteLength);
        offset += globalData.selectorsByteLength;
        globalData.tables = bytes.subarray(offset, offset + globalData.tablesByteLength);

        return globalData;
    };

    var isEtc1s = function(container) {
        return (
            container.supercompressionScheme === SUPERCOMPRESSION_BASIS_LZ ||
            (container.vkFormat === VK_FORMAT_UNDEFINED &&
                container.dfd.colorModel === COLOR_MODEL_ETC1S)
        );
    };

    var isUastc = function(container) {
        return (
            container.vkFormat === VK_FORMAT_UNDEFINED &&
            container.dfd.colorModel === COLOR_MODEL_UASTC
        );
    };

    var hasAlpha = function(container) {
        var samples = container.dfd.samples;
        var i;
        if (isEtc1s(container)) {
            for (i = 0; i < samples.length; i++) {
                if (samples[i].channelType === CHANNEL_ETC1S_AAA) return true;
            }
            return false;
        }
        if (isUastc(container)) {
            return samples.length > 0 && samples[0].channelType === CHANNEL_UASTC_RGBA;
        }
        return false;
    };

    /**
     * Parses the KTX2 container of the given buffer.
     * @param {ArrayBuffer} arrayBuffer the whole .ktx2 file
     * @returns {Object} the parsed container, or undefined if the identifier does not match
     */
    var parse = function(arrayBuffer) {
        var bytes = new Uint8Array(arrayBuffer);
        if (!hasIdentifier(bytes)) return undefined;

        var dataView = new DataView(arrayBuffer);
        var offset = KTX2_IDENTIFIER.length;

        var container = {
            vkFormat: dataView.getUint32(offset, true),
            typeSize: dataView.getUint32(offset + 4, true),
            pixelWidth: dataView.getUint32(offset + 8, true),
            pixelHeight: dataView.getUint32(offset + 12, true),
            pixelDepth: dataView.getUint32(offset + 16, true),
            layerCount: dataView.getUint32(offset + 20, true),
            faceCount: dataView.getUint32(offset + 24, true),
            levelCount: dataView.getUint32(offset + 28, true),
            supercompressionScheme: dataView.getUint32(offset + 32, true)
        };
        offset += 36;

        var index = {
            dfdByteOffset: dataView.getUint32(offset, true),
            dfdByteLength: dataView.getUint32(offset + 4, true),
            kvdByteOffset: dataView.getUint32(offset + 8, true),
            kvdByteLength: dataView.getUint32(offset + 12, true),
            sgdByteOffset: getUint64(dataView, offset + 16),
            sgdByteLength: getUint64(dataView, offset + 24)
        };
        offset += 32;

        // levelCount 0 means a single level whose mipmaps are generated at runtime
        container.levelCount = Math.max(1, container.levelCount);
        container.layerCount = Math.max(1, container.layerCount);
        container.faceCount = Math.max(1, container.faceCount);
        container.pixelHeight = Math.max(1, container.pixelHeight);

        container.levels = [];
        for (var level = 0; level < container.levelCount; level++) {
            container.levels.push({
                byteOffset: getUint64(dataView, offset),
                byteLength: getUint64(dataView, offset + 8),
                uncompressedByteLength: getUint64(dataView, offset + 16)
            });
            offset += 24;
        }

        container.dfd = parseDataFormatDescriptor(
            dataView,
            index.dfdByteOffset,
            index.dfdByteLength
        );

        container.keyValue =
            index.kvdByteLength > 0
                ? parseKeyValueData(bytes, dataView, index.kvdByteOffset, index.kvdByteLength)
                : {};

        container.basisLzGlobalData = undefined;
        if (
            container.supercompressionScheme === SUPERCOMPRESSION_BASIS_LZ &&
            index.sgdByteLength > 0
        ) {
            container.basisLzGlobalData = parseBasisLzGlobalData(
                bytes,
                dataView,
                index.sgdByteOffset,
                container.levelCount * container.layerCount * container.faceCount
            );
        }

        container.index = index;
        container.bytes = bytes;
        container.isEtc1s = isEtc1s(container);
        container.isUastc = isUastc(container);
        container.hasAlpha = hasAlpha(container);
        container.orientation = container.keyValue.KTXorientation || '';

        return container;
    };

    /**
     * Checks that the container is one we can turn into a WebGL texture.
     * @param {Object} container a container returned by parse
     * @returns {string|undefined} what is wrong with it, or undefined if it is fine
     */
    var validate = function(container) {
        if (container.faceCount !== 1) {
            return 'cubemaps are not supported, the file has ' + container.faceCount + ' faces';
        }
        if (container.layerCount !== 1) {
            return (
                'texture arrays are not supported, the file has ' + container.layerCount + ' layers'
            );
        }
        if (container.pixelDepth > 1) {
            return '3D textures are not supported';
        }

        var scheme = container.supercompressionScheme;
        if (scheme !== SUPERCOMPRESSION_NONE && scheme !== SUPERCOMPRESSION_BASIS_LZ) {
            return (
                (SUPERCOMPRESSION_NAMES[scheme] || 'scheme ' + scheme) +
                ' supercompression is not supported, encode with BasisLZ (ETC1S) or store' +
                ' UASTC uncompressed'
            );
        }

        if (
            container.vkFormat === VK_FORMAT_UNDEFINED &&
            !container.isEtc1s &&
            !container.isUastc
        ) {
            return (
                'color model ' +
                container.dfd.colorModel +
                ' is not transcodable, only ETC1S and UASTC are'
            );
        }

        if (container.isEtc1s) {
            if (container.basisLzGlobalData === undefined) {
                return 'ETC1S file without BasisLZ supercompression global data';
            }
            if (container.basisLzGlobalData.imageDescs.length < container.levelCount) {
                return (
                    'ETC1S file has ' +
                    container.basisLzGlobalData.imageDescs.length +
                    ' image descriptors for ' +
                    container.levelCount +
                    ' mipmap levels'
                );
            }
        }

        return undefined;
    };

    var levelWidth = function(container, level) {
        return Math.max(1, container.pixelWidth >> level);
    };

    var levelHeight = function(container, level) {
        return Math.max(1, container.pixelHeight >> level);
    };

    /**
     * Returns the level payloads as they are stored, for a container holding a plain Vulkan
     * format that needs no transcoding.
     * @param {Object} container a container returned by parse
     * @returns {Array} one { width, height, data } per mipmap level
     */
    var sliceLevels = function(container) {
        var levels = [];
        for (var level = 0; level < container.levelCount; level++) {
            var levelInfo = container.levels[level];
            levels.push({
                width: levelWidth(container, level),
                height: levelHeight(container, level),
                data: container.bytes.subarray(
                    levelInfo.byteOffset,
                    levelInfo.byteOffset + levelInfo.byteLength
                )
            });
        }
        return levels;
    };

    /**
     * Picks the first candidate the transcoder can actually produce for this file.
     * @param {Object} transcoderModule the msc_basis_transcoder module
     * @param {Object} container a container returned by parse
     * @param {Array} candidates [ { name, nameOpaque } ] in priority order, nameOpaque being
     *        used for a source without an alpha channel
     * @returns {string} the chosen transcoder target name, RGBA32 if nothing else fits
     */
    var selectTarget = function(transcoderModule, container, candidates) {
        var basisTextureFormat = container.isEtc1s
            ? transcoderModule.TextureFormat.ETC1S
            : transcoderModule.TextureFormat.UASTC4x4;

        for (var i = 0; i < candidates.length; i++) {
            var candidate = candidates[i];
            var name =
                !container.hasAlpha && candidate.nameOpaque ? candidate.nameOpaque : candidate.name;
            var target = transcoderModule.TranscodeTarget[name];
            if (target === undefined) continue;
            if (!transcoderModule.isFormatSupported(target, basisTextureFormat)) continue;
            return name;
        }

        return FALLBACK_TARGET_NAME;
    };

    /**
     * Transcodes every mipmap level of a Basis Universal container.
     * @param {Object} transcoderModule the msc_basis_transcoder module
     * @param {Object} container a container returned by parse
     * @param {Array} candidates [ { name, nameOpaque } ] in priority order
     * @returns {Object} { targetName, levels: [ { width, height, data } ] }
     * @throws {Error} if the transcoder rejects a level
     */
    var transcode = function(transcoderModule, container, candidates) {
        var targetName = selectTarget(transcoderModule, container, candidates);
        var target = transcoderModule.TranscodeTarget[targetName];
        var basisTextureFormat = container.isEtc1s
            ? transcoderModule.TextureFormat.ETC1S
            : transcoderModule.TextureFormat.UASTC4x4;

        var imageTranscoder = container.isEtc1s
            ? new transcoderModule.BasisLzEtc1sImageTranscoder()
            : new transcoderModule.UastcImageTranscoder();

        try {
            if (container.isEtc1s) {
                var globalData = container.basisLzGlobalData;
                imageTranscoder.decodePalettes(
                    globalData.endpointCount,
                    globalData.endpoints,
                    globalData.selectorCount,
                    globalData.selectors
                );
                imageTranscoder.decodeTables(globalData.tables);
            }

            var levels = [];
            for (var level = 0; level < container.levelCount; level++) {
                var levelInfo = container.levels[level];
                var width = levelWidth(container, level);
                var height = levelHeight(container, level);
                var levelData = container.bytes.subarray(
                    levelInfo.byteOffset,
                    levelInfo.byteOffset + levelInfo.byteLength
                );

                var imageInfo = new transcoderModule.ImageInfo(
                    basisTextureFormat,
                    width,
                    height,
                    level
                );
                var result;
                try {
                    if (container.isEtc1s) {
                        var imageDesc = container.basisLzGlobalData.imageDescs[level];
                        imageInfo.flags = imageDesc.imageFlags;
                        imageInfo.rgbByteOffset = imageDesc.rgbSliceByteOffset;
                        imageInfo.rgbByteLength = imageDesc.rgbSliceByteLength;
                        imageInfo.alphaByteOffset = imageDesc.alphaSliceByteOffset;
                        imageInfo.alphaByteLength = imageDesc.alphaSliceByteLength;
                        result = imageTranscoder.transcodeImage(
                            target,
                            levelData,
                            imageInfo,
                            0, // decodeFlags
                            false // isVideo
                        );
                    } else {
                        imageInfo.flags = 0;
                        imageInfo.rgbByteOffset = 0;
                        imageInfo.rgbByteLength = levelInfo.byteLength;
                        imageInfo.alphaByteOffset = 0;
                        imageInfo.alphaByteLength = 0;
                        result = imageTranscoder.transcodeImage(
                            target,
                            levelData,
                            imageInfo,
                            0, // decodeFlags
                            container.hasAlpha,
                            false // isVideo
                        );
                    }
                } finally {
                    imageInfo.delete();
                }

                if (result === undefined || result.transcodedImage === undefined) {
                    throw new Error(
                        'the transcoder failed on mipmap level ' +
                            level +
                            ' with target ' +
                            targetName +
                            (result && result.error !== undefined ? ', error ' + result.error : '')
                    );
                }

                // get_typed_memory_view is a view on the wasm heap, which the next transcode
                // may reuse or move, so keep our own copy. It is exactly the right size, which
                // makes its buffer transferable straight out of the worker.
                var transcodedImage = result.transcodedImage;
                var data = new Uint8Array(transcodedImage.get_typed_memory_view());
                transcodedImage.delete();

                levels.push({ width: width, height: height, data: data });
            }

            return { targetName: targetName, levels: levels };
        } finally {
            imageTranscoder.delete();
        }
    };

    return {
        FALLBACK_TARGET_NAME: FALLBACK_TARGET_NAME,
        parse: parse,
        validate: validate,
        sliceLevels: sliceLevels,
        selectTarget: selectTarget,
        transcode: transcode
    };
};

export default createKtx2Core;
