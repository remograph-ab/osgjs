import utils from 'osg/utils';
import Compiler from 'osgShader/Compiler';

var CompilerShadowCast = function() {
    Compiler.apply(this, arguments);
};

var config = Compiler.cloneStateAttributeConfig(Compiler);
config.attribute = ['ShadowCast', 'Morph', 'Skinning', 'PointSize'];

Compiler.setStateAttributeConfig(CompilerShadowCast, config);

utils.createPrototypeObject(
    CompilerShadowCast,
    utils.objectInherit(Compiler.prototype, {
        getCompilerName: function() {
            return 'ShadowCast';
        },

        initAttributes: function() {
            var attributes = this._attributes;

            for (var i = 0, l = attributes.length; i < l; i++) {
                var type = attributes[i].className();

                if (type === 'ShadowCastAttribute') {
                    this._shadowCastAttribute = attributes[i];
                } else if (type === 'Billboard') {
                    this._isBillboard = !!attributes[i];
                } else if (type === 'SkinningAttribute') {
                    this._skinningAttribute = attributes[i];
                } else if (type === 'MorphAttribute') {
                    this._morphAttribute = attributes[i];
                } else if (type === 'PointSizeAttribute') {
                    this._pointSizeAttribute = attributes[i];
                }
            }
        },

        // Only a unit 0 texture is used, as alpha mask. The shadow map nulls all texture
        // units with OVERRIDE, so it is only present here when set PROTECTED by the scene
        // (e.g. on alpha blended state sets) to cast semi-transparent shadows.
        registerTextureAttributes: function(tuTarget, tunit) {
            if (tunit === 0 && tuTarget.className() === 'Texture') {
                this.registerTexture(tuTarget, tunit);
            }
        },

        // GLSL computing ditherThreshold in ]0, 1[ from the shadow map texel position.
        // A PCF kernel of N taps per axis (bilinear taps one texel apart) averages any
        // N-periodic pattern exactly, so the period matches the receiver kernel: a lattice
        // pattern of N*N levels for the 9 and 25 tap kernels, else a 4x4 Bayer matrix.
        getDitherThresholdCode: function() {
            var receiveAttribute = this._shadowCastAttribute.getReceiveAttribute();
            var kernel = receiveAttribute ? receiveAttribute.getKernelSizePCF() : undefined;
            var period = 0;
            if (kernel === '16Tap(64texFetch)') period = 5;
            else if (kernel === '9Tap(36texFetch)') period = 3;

            if (period > 0) {
                var n = period.toFixed(1);
                var levels = (period * period).toFixed(1);
                return [
                    'vec2 ditherPos = floor(mod(gl_FragCoord.xy, ' + n + '));',
                    'float ditherCoarse = mod(ditherPos.x + 2.0 * ditherPos.y, ' + n + ');',
                    'float ditherFine = mod(ditherPos.x + ditherPos.y, ' + n + ');',
                    'float ditherIndex = ditherCoarse * ' + n + ' + ditherFine;',
                    'float ditherThreshold = (ditherIndex + 0.5) / ' + levels + ';'
                ];
            }
            return [
                'vec2 ditherPos = floor(mod(gl_FragCoord.xy, 4.0));',
                'vec2 ditherHigh = floor(ditherPos * 0.5);',
                'float ditherThreshold = fract(ditherPos.x * 0.5 + ditherPos.y * ditherPos.y * 0.75)',
                '  + 0.25 * fract(ditherHigh.x * 0.5 + ditherHigh.y * ditherHigh.y * 0.75)',
                '  + 0.03125;'
            ];
        },

        // Discards caster fragments with an ordered dither against the alpha mask, so that
        // a fraction of the shadow map texels matching the alpha is written. PCF filtering
        // on the receiver then averages them into a partial shadow, instead of an opaque
        // one. Alpha 0 never and alpha 1 always casts.
        // The discard is routed through fragEye so the shader graph keeps it.
        createAlphaMaskedFragEye: function(fragEye) {
            // by unit, as a named texture is registered by its own name instead of Texture0
            if (!this._textures[0]) return fragEye;

            var maskedEye = this.createVariable('vec4');
            this.getNode('InlineCode')
                .code(
                    this.getDitherThresholdCode()
                        .concat([
                            'if (texture2D(%tex, %uv).a < ditherThreshold) discard;',
                            '%outEye = %eye;'
                        ])
                        .join('\n')
                )
                .inputs({
                    tex: this.getOrCreateSampler('sampler2D', 'Texture0'),
                    uv: this.getOrCreateVarying('vec2', 'vTexCoord0'),
                    eye: fragEye
                })
                .outputs({ outEye: maskedEye });

            return maskedEye;
        },

        // Depth Shadow Map Casted from Light POV Depth encoded in color buffer
        createShadowCastDepth: function(out) {
            var defines = this._shadowCastAttribute.getDefines();

            var node = this.getNode('ShadowCast')
                .inputs({
                    shadowDepthRange: this.getOrCreateUniform('vec4', 'uShadowDepthRange'),
                    fragEye: this.createAlphaMaskedFragEye(this.getOrCreateViewVertex())
                })
                .outputs({ result: out });

            node.getDefines = function() {
                return defines;
            };

            return out;
        },

        // encapsulate for easier overwrite by user defined compiler
        // that would inherint from this compiler Do not merge with above method
        createFragmentShaderGraph: function() {
            var frag = this.getNode('glFragColor');
            return [this.createShadowCastDepth(frag)];
        }
    }),
    'osgShader',
    'CompilerShadowCast'
);

export default CompilerShadowCast;
