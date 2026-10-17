/*eslint-env node*/
'use strict';

//
// Regenerates mscBasisTranscoderInlined.js from the upstream KTX-Software artifacts
// msc_basis_transcoder.js and msc_basis_transcoder.wasm sitting next to this script.
//
// Run with:  node sources/osgDB/ktx2/generateInlined.js
//
// Why inline the transcoder instead of importing/fetching it?
//  - The emscripten glue uses syntax (optional chaining, optional catch binding) that the
//    webpack 3 parser used to build OSG.js cannot handle, so it has to stay a plain string
//    that is evaluated at runtime.
//  - Keeping the wasm as base64 in the bundle means OSG.js stays a single self contained
//    file. Consumers (swea is embedded into third party pages) do not have to deploy and
//    configure the URL of an extra .wasm asset.
//

var fs = require('fs');
var path = require('path');

var HERE = __dirname;
var GLUE_FILE = path.join(HERE, 'msc_basis_transcoder.js');
var WASM_FILE = path.join(HERE, 'msc_basis_transcoder.wasm');
var OUTPUT_FILE = path.join(HERE, 'mscBasisTranscoderInlined.js');

// Turns arbitrary text into a pure ASCII JavaScript string literal. JSON.stringify does most
// of the work but leaves every non ASCII code unit as is, including U+2028 and U+2029 which
// terminate a line in JavaScript source before ES2019, so escape those too.
var toStringLiteral = function(text) {
    return JSON.stringify(text).replace(/[^\x20-\x7e]/g, function(character) {
        return '\\u' + ('000' + character.charCodeAt(0).toString(16)).slice(-4);
    });
};

var glue = fs.readFileSync(GLUE_FILE, 'utf8');
var wasm = fs.readFileSync(WASM_FILE);

var version = 'unknown';
var packageJson = path.join(HERE, '..', '..', '..', 'package.json');
if (fs.existsSync(packageJson)) {
    version = JSON.parse(fs.readFileSync(packageJson, 'utf8')).version;
}

var output = [
    '//',
    '// GENERATED FILE - DO NOT EDIT.',
    '//',
    '// Produced by sources/osgDB/ktx2/generateInlined.js from the upstream KTX-Software',
    '// msc_basis_transcoder.js / msc_basis_transcoder.wasm artifacts in the same directory.',
    '// See README.md there for provenance and for how to update the transcoder.',
    '//',
    '// osgjs version at generation time: ' + version,
    '//',
    '',
    '// The emscripten glue code, evaluated at runtime (see mscBasisTranscoder.js).',
    'export var MSC_BASIS_TRANSCODER_JS = ' + toStringLiteral(glue) + ';',
    '',
    '// The wasm module, base64 encoded (' + wasm.length + ' bytes decoded).',
    'export var MSC_BASIS_TRANSCODER_WASM_BASE64 = ' +
        toStringLiteral(wasm.toString('base64')) +
        ';',
    ''
].join('\n');

fs.writeFileSync(OUTPUT_FILE, output);

console.log(
    'Wrote ' +
        OUTPUT_FILE +
        ' (' +
        output.length +
        ' bytes) from ' +
        glue.length +
        ' bytes of glue and ' +
        wasm.length +
        ' bytes of wasm.'
);
