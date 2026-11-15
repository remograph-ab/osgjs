import { assert } from 'chai';
import Texture from 'osg/Texture';
import WebGLCaps from 'osg/WebGLCaps';
import mockup from 'tests/mockup/mockup';

export default function() {
    test('WebGLCaps', function() {
        var canvas = mockup.createCanvas(true);
        var gl = canvas.getContext();
        var webglCaps = WebGLCaps.instance(gl);

        webglCaps.getWebGLExtensions().OES_texture_float = true; // eslint-disable-line
        webglCaps._checkRTT[Texture.FLOAT + ',' + Texture.NEAREST] = true;

        var hFloat = webglCaps.hasFloatRTT(gl);
        assert.isOk(hFloat, 'float detect');
    });

    test('WebGLCaps.applyExtension after a lost context', function() {
        var lostExtension = {
            bindVertexArrayOES: function() {
                return 'lost';
            },
            VERTEX_ARRAY_BINDING_OES: 1
        };
        var restoredExtension = {
            bindVertexArrayOES: function() {
                return 'restored';
            },
            VERTEX_ARRAY_BINDING_OES: 2
        };
        var gl = {
            native: function() {
                return 'native';
            }
        };
        var caps = WebGLCaps.instance();

        gl.getExtension = function() {
            return lostExtension;
        };
        caps.applyExtension(gl, 'OES_vertex_array_object');
        assert.equal(gl.bindVertexArray(), 'lost', 'Check extension function copied');

        // A restored context hands out new extension objects
        gl.getExtension = function() {
            return restoredExtension;
        };
        caps.applyExtension(gl, 'OES_vertex_array_object');
        assert.equal(gl.bindVertexArray(), 'restored', 'Check new extension function');
        assert.equal(gl.VERTEX_ARRAY_BINDING, 2, 'Check new extension constant');

        // Native functions are never replaced by extension ones
        gl.getExtension = function() {
            return {
                nativeOES: function() {
                    return 'extension';
                }
            };
        };
        caps.applyExtension(gl, 'OES_native');
        assert.equal(gl.native(), 'native', 'Check native function kept');
    });
}
