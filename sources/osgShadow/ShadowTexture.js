import notify from 'osg/notify';
import Texture from 'osg/Texture';
import Uniform from 'osg/Uniform';
import utils from 'osg/utils';
import { vec4 } from 'osg/glMatrix';
import { vec2 } from 'osg/glMatrix';

/**
 * ShadowTexture Attribute encapsulate Texture webgl object
 * with Shadow specificities (no need of texcoord,fragtexcoord)
 * trigger hash change when changing texture precision from float to byt
 * shadowSettings.js header for param explanations
 * @class ShadowTexture
 * @inherits StateAttribute
 */
var ShadowTexture = function() {
    Texture.call(this);

    this._uniforms = {};
    this._mapSize = vec4.create();
    this._renderSize = vec2.create();
    this._lightNumber = -1; // default for a valid cloneType
    this._dirtyHash = true;
    this._hash = '';
};

ShadowTexture.uniforms = {};
/** @lends Texture.prototype */
utils.createPrototypeStateAttribute(
    ShadowTexture,
    utils.objectInherit(Texture.prototype, {
        cloneType: function() {
            return new ShadowTexture();
        },
        invalidate: function() {
            Texture.prototype.invalidate.call(this);
            this.dirty();
        },
        hasLightNumber: function(lightNum) {
            return this._lightNumber === lightNum;
        },

        setLightNumber: function(lun) {
            this._lightNumber = lun;
            this._dirtyHash = true;
        },

        getLightNumber: function() {
            return this._lightNumber;
        },

        getUniformName: function(name) {
            var prefix = 'Shadow_' + this.getType() + this._lightNumber.toString();
            return 'u' + prefix + '_' + name;
        },

        setInternalFormatType: function(value) {
            Texture.prototype.setInternalFormatType.call(this, value);
            this._dirtyHash = true;
        },

        getOrCreateUniforms: function(unit) {
            // uniform are once per CLASS attribute, not per instance
            var obj = ShadowTexture;

            notify.assert(unit !== undefined);
            notify.assert(this._lightNumber !== -1);

            if (obj.uniforms[unit] !== undefined) return obj.uniforms[unit];

            var uniforms = (obj.uniforms[unit] = {
                ViewRight: Uniform.createFloat4(this.getUniformName('viewRight')),
                ViewUp: Uniform.createFloat4(this.getUniformName('viewUp')),
                ViewLook: Uniform.createFloat4(this.getUniformName('viewLook')),
                Projection: Uniform.createFloat3(this.getUniformName('projection')),
                DepthRange: Uniform.createFloat2(this.getUniformName('depthRange')),
                MapSize: Uniform.createFloat4(this.getUniformName('mapSize')),
                RenderSize: Uniform.createFloat2(this.getUniformName('renderSize'))
            });

            // Dual Uniform of texture, needs:
            // - Sampler (type of texture)
            // - Int (texture unit)
            // tells Shader Program where to find it
            var name = 'Texture' + unit;
            var uniform = Uniform.createInt1(unit, name);
            uniforms[name] = uniform;

            return obj.uniforms[unit];
        },

        setViewMatrix: function(viewMatrix) {
            this._viewMatrix = viewMatrix;
        },

        setProjection: function(projection) {
            this._projection = projection;
        },

        setDepthRange: function(depthRange) {
            this._depthRange = depthRange;
        },

        setTextureSize: function(w, h) {
            Texture.prototype.setTextureSize.call(this, w, h);
            this.dirty();
            this._mapSize[0] = w;
            this._mapSize[1] = h;
            this._mapSize[2] = 1.0 / w;
            this._mapSize[3] = 1.0 / h;

            this._renderSize[0] = 1.0 / w;
            this._renderSize[1] = 1.0 / h;
        },

        // optimize a mat4 into 3 vec4 unforms
        // The receivers' world positions are relative to the render origin (see osg.State.setRenderOrigin),
        // so the view matrix is multiplied with the translation to it, if given.
        _updateViewMatrixUniforms: function(viewMatrix, viewRight, viewUp, viewLook, origin) {
            var v;
            var m = viewMatrix;
            var ox = origin !== undefined ? origin[0] : 0.0;
            var oy = origin !== undefined ? origin[1] : 0.0;
            var oz = origin !== undefined ? origin[2] : 0.0;
            v = viewRight.getInternalArray();
            v[0] = m[0];
            v[1] = m[4];
            v[2] = m[8];
            v[3] = m[0] * ox + m[4] * oy + m[8] * oz + m[12];

            v = viewUp.getInternalArray();
            v[0] = m[1];
            v[1] = m[5];
            v[2] = m[9];
            v[3] = m[1] * ox + m[5] * oy + m[9] * oz + m[13];

            v = viewLook.getInternalArray();
            v[0] = m[2];
            v[1] = m[6];
            v[2] = m[10];
            v[3] = m[2] * ox + m[6] * oy + m[10] * oz + m[14];
        },

        apply: function(state, texNumber) {
            // Texture stuff: call parent class method
            Texture.prototype.apply.call(this, state, texNumber);

            if (this._lightNumber === -1) return;

            // update Uniforms
            var uniformMap = this.getOrCreateUniforms(texNumber);

            this._updateViewMatrixUniforms(
                this._viewMatrix,
                uniformMap.ViewRight,
                uniformMap.ViewUp,
                uniformMap.ViewLook,
                state.getRenderOrigin()
            );
            uniformMap.Projection.setFloat3(this._projection);
            uniformMap.DepthRange.setFloat2(this._depthRange);
            uniformMap.MapSize.setFloat4(this._mapSize);
            uniformMap.RenderSize.setFloat2(this._renderSize);
        },

        getHash: function() {
            if (!this._dirtyHash) return this._hash;

            this._hash = this._computeInternalHash();
            this._dirtyHash = false;
            return this._hash;
        },

        _computeInternalHash: function() {
            return this.getTypeMember() + '_' + this._lightNumber + '_' + this._type;
        }
    }),
    'osgShadow',
    'ShadowTexture'
);

export default ShadowTexture;
