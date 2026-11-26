import { mat4 } from 'osg/glMatrix';
import { mat3 } from 'osg/glMatrix';
import { vec3 } from 'osg/glMatrix';
import notify from 'osg/notify';
import Object from 'osg/Object';
import Program from 'osg/Program';
import StateAttribute from 'osg/StateAttribute';
import PooledArray from 'osg/PooledArray';
import StackObjectPairPool from 'osg/StackObjectPairPool';
import Uniform from 'osg/Uniform';
import utils from 'osg/utils';
import WebGLCaps from 'osg/WebGLCaps';
import StateCache from 'osg/StateCache';

var checkUniformCache = [
    undefined,
    function uniformCheck1(uniformArray, cacheArray) {
        if (uniformArray[0] === cacheArray[0]) return true;
        cacheArray[0] = uniformArray[0];
        return false;
    },

    function uniformCheck2(uniformArray, cacheArray) {
        if (uniformArray[0] === cacheArray[0] && uniformArray[1] === cacheArray[1]) return true;
        cacheArray[0] = uniformArray[0];
        cacheArray[1] = uniformArray[1];
        return false;
    },

    function uniformCheck3(uniformArray, cacheArray) {
        if (
            uniformArray[0] === cacheArray[0] &&
            uniformArray[1] === cacheArray[1] &&
            uniformArray[2] === cacheArray[2]
        )
            return true;
        cacheArray[0] = uniformArray[0];
        cacheArray[1] = uniformArray[1];
        cacheArray[2] = uniformArray[2];
        return false;
    },

    function uniformCheck4(uniformArray, cacheArray) {
        if (
            uniformArray[0] === cacheArray[0] &&
            uniformArray[1] === cacheArray[1] &&
            uniformArray[2] === cacheArray[2] &&
            uniformArray[3] === cacheArray[3]
        )
            return true;
        cacheArray[0] = uniformArray[0];
        cacheArray[1] = uniformArray[1];
        cacheArray[2] = uniformArray[2];
        cacheArray[3] = uniformArray[3];
        return false;
    }
];

var State = function(shaderGeneratorProxy) {
    Object.call(this);

    this._excludeUniforms = {
        uProjectionMatrix: true,
        uModelMatrix: true,
        uViewMatrix: true,
        uModelViewMatrix: true,
        uModelNormalMatrix: true,
        uModelViewNormalMatrix: true,
        uArrayColorEnabled: true,
        uRenderOrigin: true
    };
    // Texture coordinate shifts are set per geometry (see applyTexCoordShifts)
    for (var shiftUnit = 0; shiftUnit < State.MAX_TEXCOORD_SHIFT_UNITS; ++shiftUnit) {
        this._excludeUniforms['uTexCoordShift' + shiftUnit] = true;
    }

    this._graphicContext = undefined;
    this._shaderGeneratorProxy = shaderGeneratorProxy;

    if (shaderGeneratorProxy === undefined) console.break();

    this._currentVAO = null;
    this._currentIndexVBO = null;

    this._stateSets = new PooledArray();
    this._shaderGeneratorNames = new StackObjectPairPool();
    this._uniforms = {};

    this._textureAttributeArrayList = [];
    this._attributeArray = [];

    this._projectionMatrix = Uniform.createMatrix4(mat4.create(), 'uProjectionMatrix');
    this._modelMatrix = Uniform.createMatrix4(mat4.create(), 'uModelMatrix');
    this._viewMatrix = Uniform.createMatrix4(mat4.create(), 'uViewMatrix');
    this._modelViewMatrix = Uniform.createMatrix4(mat4.create(), 'uModelViewMatrix');
    this._modelNormalMatrix = Uniform.createMatrix3(mat3.create(), 'uModelNormalMatrix');
    this._modelViewNormalMatrix = Uniform.createMatrix3(mat3.create(), 'uModelViewNormalMatrix');

    // Render origin, a world position near the camera (see setRenderOrigin). Programs whose vertex
    // shader subtracts uRenderOrigin (the render origin in the model coordinates) from the vertex
    // get model-view, model and view matrices relative to it, so that the GPU never handles large
    // coordinates near the camera.
    this._renderOrigin = vec3.create();
    this._renderOriginLocal = vec3.create();
    this._renderOriginUniform = Uniform.createFloat3(vec3.create(), 'uRenderOrigin');
    this._renderOriginModelView = mat4.create();
    this._renderOriginModel = mat4.create();
    this._renderOriginView = mat4.create();
    this._renderOriginInverseModel = mat4.create();
    // True if the last applied model-view matrix was made relative to the render origin
    this._renderOriginApplied = false;
    // The render origin in the model coordinates and the inverse model matrix, for texture coordinate shifts
    this._texCoordShiftLocal = vec3.create();
    this._texCoordShiftInverseModel = mat4.create();

    // track uniform for color array enabled
    var arrayColorEnable = new StackObjectPairPool();
    arrayColorEnable._globalDefault = Uniform.createFloat1(0.0, 'uArrayColorEnabled');

    this._uniforms.ArrayColorEnabled = arrayColorEnable;

    this._previousColorAttribPair = {};
    this._vertexAttribMap = {};
    this._vertexAttribMap._disable = [];
    this._vertexAttribMap._keys = [];

    this._frameStamp = undefined;

    // we dont use Map because in this use case with a few entries
    // {} is faster
    this._programCommonUniformsCache = {};

    // keep pointer on the last applied modelview and projection matrix
    this._lastAppliedModelViewMatrix = undefined;
    this._lastAppliedProjectionMatrix = undefined;

    // keep track of last applied program
    this._program = undefined;
    // inject a default program to initialize the stack Program
    var program = new Program();
    this.applyAttribute(program);

    // cache programAttribute access
    this._programType = utils.getOrCreateStateAttributeTypeMemberIndex(program);
    this._programAttribute = this._attributeArray[this._programType];

    this._numPushStateSet = 0;
    this._numApply = 0;

    this._programUniformCache = [];
    this._cacheUniformId = 0;

    // gl states cache
    this._stateCache = new StateCache();

    this.resetStats();
};

utils.createPrototypeObject(
    State,
    utils.objectInherit(Object.prototype, {
        // excludeUniforms is a list of uniforms that will not be applied or checked automatically when applying a program
        // you should not add you uniforms in this list until you really know what you are doing.
        // The use case of the exclusions is because the RenderLeaf.drawGeometry will apply them without UniformStack and
        // it should be applied automatically because you will apply them RenderLeaf.drawGeometry.
        // If you are writing a custom renderStage or overriding RenderLeaf.drawGeometry and add new uniform and custom
        // behavior then it can make sense to add uniforms here.
        // To make it work you should add your uniforms before the rendering (usually before viewer.run())
        getExcludeUniforms: function() {
            return this._excludeUniforms;
        },

        resetCaches: function() {
            this._currentVAO = null;
            this._currentIndexVBO = null;

            this._previousColorAttribPair = {};
            this._vertexAttribMap = {};
            this._vertexAttribMap._disable = [];
            this._vertexAttribMap._keys = [];

            this._programCommonUniformsCache = {};

            // A restored context starts with the default GL state, so also forget what has been
            // applied (e.g. depth test, culling, blending, the program and textures) to apply it all again.
            // Otherwise e.g. the depth test stays disabled, since it is believed to be enabled already.
            this._stateCache = new StateCache();
            this._program = undefined;
            this._lastAppliedModelViewMatrix = undefined;
            this._lastAppliedProjectionMatrix = undefined;

            var i;
            for (i = 0; i < this._attributeArray.length; i++) {
                if (this._attributeArray[i]) this._attributeArray[i]._lastApplied = undefined;
            }
            for (i = 0; i < this._textureAttributeArrayList.length; i++) {
                var textureAttributeArray = this._textureAttributeArrayList[i];
                if (!textureAttributeArray) continue;
                for (var j = 0; j < textureAttributeArray.length; j++) {
                    if (textureAttributeArray[j]) textureAttributeArray[j]._lastApplied = undefined;
                }
            }
        },

        applyColorMask: function(attribute) {
            this._stateCache.applyColorMaskAttribute(attribute);
        },

        applyBlendFunc: function(attribute) {
            this._stateCache.applyBlendFuncAttribute(attribute);
        },

        applyBlendEquation: function(attribute) {
            this._stateCache.applyBlendEquationAttribute(attribute);
        },

        applyCullFace: function(attribute) {
            this._stateCache.applyCullFaceAttribute(attribute);
        },

        applyDepth: function(attribute) {
            this._stateCache.applyDepthAttribute(attribute);
        },

        applyViewport: function(attribute) {
            this._stateCache.applyViewportAttribute(attribute);
        },

        applyScissor: function(attribute) {
            this._stateCache.applyScissorAttribute(attribute);
        },

        applyPolygonOffset: function(attribute) {
            this._stateCache.applyPolygonOffsetAttribute(attribute);
        },

        viewport: function(x, y, width, height) {
            this._stateCache.viewport(x, y, width, height);
        },

        getViewportSize: function(result) {
            var viewport = this._stateCache._stateViewport.buffer;
            result[0] = viewport.width;
            result[1] = viewport.height;
            return result;
        },

        getModelViewMatrix: function() {
            return this._modelViewMatrix.getInternalArray();
        },

        depthMask: function(value) {
            this._stateCache.depthMask(value);
        },

        clearDepth: function(value) {
            this._stateCache.clearDepth(value);
        },

        clearColor: function(value) {
            this._stateCache.clearColor(value);
        },

        clear: function(mask) {
            this._stateCache.clear(this._graphicContext, mask);
        },

        drawGeometry: function(geom) {
            this._stateCache.drawGeometry(this._graphicContext, geom);
        },

        getCacheUniformsApplyRenderLeaf: function() {
            return this._programCommonUniformsCache;
        },

        setGraphicContext: function(graphicContext) {
            this._graphicContext = graphicContext;
            this._extVAO = WebGLCaps.instance(graphicContext).getWebGLExtension(
                'OES_vertex_array_object'
            );
        },

        getGraphicContext: function() {
            return this._graphicContext;
        },

        getShaderGeneratorProxy: function() {
            return this._shaderGeneratorProxy;
        },

        pushCheckOverride: function(stack, object, maskValue) {
            var result = this._evaluateOverrideObjectOnStack(stack, object, maskValue);
            // override and protected case
            if (result !== object) stack.push(result, stack._back.value);
            else stack.push(object, maskValue);
        },

        _evaluateOverrideObjectOnStack: function(stack, object, maskValue) {
            var back = stack._back;
            // object can be a Uniform, an Attribute, or a shader generator name
            if (stack._length === 0) {
                return object;
            } else if (
                back.value & StateAttribute.OVERRIDE &&
                !(maskValue & StateAttribute.PROTECTED)
            ) {
                return back.object;
            } else {
                return object;
            }
        },

        pushStateSet: function(stateset) {
            this._numPushStateSet++;
            this._stateSets.push(stateset);

            this.pushAttributeMap(
                this._attributeArray,
                stateset._attributeArray,
                stateset._activeAttribute
            );

            var textureAttributeArrayList = stateset._textureAttributeArrayList;
            var activeTextureUnits = stateset._activeTextureAttributeUnit;
            var activeTextureAttribute = stateset._activeTextureAttribute;

            for (var i = 0, l = activeTextureUnits.length; i < l; i++) {
                var unit = activeTextureUnits[i];
                var _attributeArray = textureAttributeArrayList[unit];

                var textureUnitAttributeArray = this.getOrCreateTextureAttributeArray(unit);
                this.pushAttributeMap(
                    textureUnitAttributeArray,
                    _attributeArray,
                    activeTextureAttribute
                );
            }

            if (stateset.hasUniform())
                this.pushUniformsList(this._uniforms, stateset.getUniformList());

            var generatorPair = stateset.getShaderGeneratorPair();
            if (generatorPair)
                this.pushCheckOverride(
                    this._shaderGeneratorNames,
                    generatorPair.getShaderGeneratorName(),
                    generatorPair.getValue()
                );
        },

        getStateSetStackSize: function() {
            return this._stateSets.getLength();
        },

        insertStateSet: (function() {
            var tmpStack = new PooledArray();
            var tmpStackArray = tmpStack.getArray();
            return function(pos, stateSet) {
                tmpStack.reset();
                var length = this.getStateSetStackSize();
                while (length > pos) {
                    tmpStack.push(this._stateSets.back());
                    this.popStateSet();
                    length--;
                }

                this.pushStateSet(stateSet);

                for (var i = tmpStack._length - 1; i >= 0; i--) {
                    this.pushStateSet(tmpStackArray[i]);
                }
            };
        })(),

        removeStateSet: (function() {
            var tmpStack = new PooledArray();
            var tmpStackArray = tmpStack.getArray();
            return function(pos) {
                var length = this.getStateSetStackSize();
                if (pos >= length) {
                    notify.warn('Warning State:removeStateSet ' + pos + ' out of range');
                    return;
                }

                tmpStack.reset();

                // record the StateSet above the one we intend to remove
                while (length - 1 > pos) {
                    tmpStack.push(this._stateSets.back());
                    this.popStateSet();
                    length--;
                }

                // remove the intended StateSet as well
                this.popStateSet();

                // push back the original ones that were above the remove StateSet
                for (var i = tmpStack._length - 1; i >= 0; i--) {
                    this.pushStateSet(tmpStackArray[i]);
                }
            };
        })(),

        // needed because we use a cache during the frame to avoid
        // applying uniform or operation. At each frame we need to
        // invalidate those informations
        resetCacheFrame: function() {
            this._lastAppliedModelViewMatrix = this._lastAppliedProjectionMatrix = undefined;
        },

        resetStats: function() {
            this._numApply = 0;
            this._numPushStateSet = 0;
        },

        // apply program if needed
        applyProgram: function(program) {
            if (this._program === program) return;
            this._program = program;
            this.getGraphicContext().useProgram(program);
        },

        applyModelViewMatrix: (function() {
            var normal = mat3.create();

            return function StateApplyModelViewMatrix(matrix, matrixModel) {
                if (this._lastAppliedModelViewMatrix === matrix) return false;

                var program = this.getLastProgramApplied();
                var uniformCache = program.getUniformsCache();
                var gc = this.getGraphicContext();

                // Programs that subtract the render origin from the vertex get the model-view
                // matrix multiplied with the translation to it
                var modelView = matrix;
                var originLocation = uniformCache.uRenderOrigin;
                this._renderOriginApplied = originLocation !== undefined;
                if (this._renderOriginApplied) {
                    modelView = this._applyRenderOrigin(matrix, matrixModel, gc, originLocation);
                }

                var mu = this._modelViewMatrix;
                var mul = uniformCache.uModelViewMatrix;
                if (mul) {
                    mu.setMatrix4(modelView);
                    mu.apply(gc, mul);
                }

                var sendNormal;
                if (this._lastAppliedModelViewMatrix) {
                    // check if we need to push normal
                    // test rotation component, if not diff
                    // we dont need to send normal
                    var m2 = this._lastAppliedModelViewMatrix;
                    for (var i = 0; i < 11; i++) {
                        if (matrix[i] !== m2[i]) {
                            sendNormal = true;
                            break;
                        }
                    }
                } else {
                    sendNormal = true;
                }

                if (sendNormal) {
                    mu = this._modelViewNormalMatrix;
                    mul = uniformCache.uModelViewNormalMatrix;
                    if (mul) {
                        mat3.normalFromMat4(normal, matrix);
                        mu.setMatrix3(normal);
                        mu.apply(gc, mul);
                    }

                    mul = uniformCache.uModelNormalMatrix;
                    if (mul) {
                        mat3.normalFromMat4(normal, matrixModel);
                        mu.setMatrix3(normal);
                        mu.apply(gc, mul);
                    }
                }

                this._lastAppliedModelViewMatrix = matrix;
                return true;
            };
        })(),

        /**
         * Sets the render origin, a world position that should be kept near the camera, e.g. by
         * moving it in steps when the camera has moved far enough from it (see
         * osgViewer.Viewer.setRenderOriginGridSize). Shaders from the shader generator subtract it, in
         * the model coordinates, from each vertex before transforming it, and get their model-view,
         * model and view matrices relative to it. The GPU then only handles small coordinates near the
         * camera, avoiding jittering from the 32-bit float precision when the coordinates are large,
         * e.g. hundreds of kilometers from the model origin. Positions computed in world space by those
         * shaders (e.g. with uModelMatrix) are relative to the render origin, so world positions given
         * as uniforms to them must be too (see getRenderOrigin). Custom programs without uRenderOrigin
         * are not affected. Defaults to (0, 0, 0), which changes nothing.
         * @param {vec3} origin The render origin in world coordinates.
         */
        setRenderOrigin: function(origin) {
            vec3.copy(this._renderOrigin, origin);
        },

        /**
         * Returns the render origin, see setRenderOrigin.
         * @returns {vec3} The render origin in world coordinates.
         */
        getRenderOrigin: function() {
            return this._renderOrigin;
        },

        /**
         * Returns true if the last applied model-view matrix was made relative to the render origin,
         * since the program subtracts it from the vertex (see setRenderOrigin).
         * @returns {boolean} True if relative to the render origin.
         */
        isRenderOriginApplied: function() {
            return this._renderOriginApplied;
        },

        /**
         * Computes the render origin in the model coordinates, rounded to 32-bit floats as the shader
         * receives it, sets it to the uRenderOrigin uniform, and computes the model-view and model
         * matrices with the translation to it.
         * @returns {mat4} The model-view matrix relative to the render origin.
         * @private
         */
        _applyRenderOrigin: function(matrix, matrixModel, gc, originLocation) {
            var origin = this._renderOrigin;
            var local = this._renderOriginLocal;
            var model = this._renderOriginModel;

            if (origin[0] === 0.0 && origin[1] === 0.0 && origin[2] === 0.0) {
                vec3.set(local, 0.0, 0.0, 0.0);
            } else if (
                matrixModel !== undefined &&
                mat4.invert(this._renderOriginInverseModel, matrixModel)
            ) {
                vec3.transformMat4(local, origin, this._renderOriginInverseModel);
            } else {
                vec3.copy(local, origin);
            }
            // Round to what the shader gets, so that the matrices compensate exactly for what it subtracts
            local[0] = Math.fround(local[0]);
            local[1] = Math.fround(local[1]);
            local[2] = Math.fround(local[2]);

            var uniform = this._renderOriginUniform;
            uniform.setFloat3(local);
            uniform.apply(gc, originLocation);

            // modelView * T(local)
            mat4.translate(this._renderOriginModelView, matrix, local);

            // T(-origin) * model * T(local), so that the world positions are relative to the render origin
            if (matrixModel !== undefined) {
                mat4.translate(model, matrixModel, local);
            } else {
                mat4.fromTranslation(model, local);
            }
            model[12] -= origin[0];
            model[13] -= origin[1];
            model[14] -= origin[2];

            return this._renderOriginModelView;
        },

        /**
         * Sets the texture coordinate shift uniforms (uTexCoordShiftN, see
         * osgShader.CompilerVertex.declareVertexTexCoord) of the current program for a geometry. For a
         * texture coordinate unit with large repeating coordinates that are an affine function of the
         * vertex X and Y (e.g. a detail texture repeated every few meters over a terrain tile), the shift
         * is the even integer nearest the coordinates at the render origin, otherwise 0. Even, so that
         * mirrored repeats are kept too.
         * @param {Array<Object>} shiftUniforms Objects with unit, location and the last applied u, v.
         * @param {osg.Geometry} geometry The geometry to draw.
         * @param {mat4} matrixModel The model matrix, undefined for identity.
         */
        applyTexCoordShifts: function(shiftUniforms, geometry, matrixModel) {
            var gl = this.getGraphicContext();
            var maps = State.getTexCoordShiftMaps(geometry);
            var origin = this._renderOrigin;
            var local;
            for (var i = 0; i < shiftUniforms.length; ++i) {
                var shiftUniform = shiftUniforms[i];
                var map = maps[shiftUniform.unit];
                var su = 0.0;
                var sv = 0.0;
                if (map && (origin[0] !== 0.0 || origin[1] !== 0.0 || origin[2] !== 0.0)) {
                    if (local === undefined) {
                        local = this._texCoordShiftLocal;
                        if (
                            matrixModel !== undefined &&
                            mat4.invert(this._texCoordShiftInverseModel, matrixModel)
                        ) {
                            vec3.transformMat4(local, origin, this._texCoordShiftInverseModel);
                        } else {
                            vec3.copy(local, origin);
                        }
                    }
                    su = 2.0 * Math.round((map[0] * local[0] + map[1] * local[1] + map[2]) * 0.5);
                    sv = 2.0 * Math.round((map[3] * local[0] + map[4] * local[1] + map[5]) * 0.5);
                }
                if (su !== shiftUniform.u || sv !== shiftUniform.v) {
                    shiftUniform.u = su;
                    shiftUniform.v = sv;
                    gl.uniform2f(shiftUniform.location, su, sv);
                }
            }
        },

        /**
         * Returns the model matrix to apply as uModelMatrix for the last applied model-view matrix,
         * relative to the render origin if the program subtracts it (see setRenderOrigin).
         * @param {mat4} matrixModel The model matrix.
         * @returns {mat4} The model matrix to apply.
         */
        getModelMatrixToApply: function(matrixModel) {
            return this._renderOriginApplied ? this._renderOriginModel : matrixModel;
        },

        /**
         * Returns the view matrix to apply as uViewMatrix for the last applied model-view matrix,
         * relative to the render origin if the program subtracts it (see setRenderOrigin).
         * @param {mat4} matrixView The view matrix.
         * @returns {mat4} The view matrix to apply.
         */
        getViewMatrixToApply: function(matrixView) {
            if (!this._renderOriginApplied) return matrixView;
            return mat4.translate(this._renderOriginView, matrixView, this._renderOrigin);
        },

        applyProjectionMatrix: function(matrix) {
            if (this._lastAppliedProjectionMatrix === matrix) return;

            this._lastAppliedProjectionMatrix = matrix;
            var program = this.getLastProgramApplied();
            var mu = this._projectionMatrix;

            var mul = program.getUniformsCache()[mu.getName()];
            if (mul) {
                mu.setMatrix4(matrix);
                mu.apply(this.getGraphicContext(), mul);
            }
        },

        getCurrentShaderGeneratorStateSet: function(stateset) {
            var programStack = this._programAttribute;
            var stateSetProgramPair = stateset._attributeArray[this._programType];

            if (
                (programStack._length !== 0 && programStack._back.value !== StateAttribute.OFF) ||
                (stateSetProgramPair && stateSetProgramPair.getValue() !== StateAttribute.OFF)
            )
                return undefined;

            var stateSetGeneratorPair = stateset.getShaderGeneratorPair();
            var generatorStack = this._shaderGeneratorNames;
            var generator;

            if (stateSetGeneratorPair) {
                var maskValue = stateSetGeneratorPair.getValue();
                var stateSetGenerator = stateSetGeneratorPair.getShaderGeneratorName();
                generator = this._evaluateOverrideObjectOnStack(
                    this._shaderGeneratorNames,
                    stateSetGenerator,
                    maskValue
                );
            } else if (generatorStack._length) {
                generator = generatorStack._back.object;
            }

            // no custom program look into the stack of ShaderGenerator name
            // what we should use to generate a program
            var last = generator;
            var shaderGenerator = this._shaderGeneratorProxy.getShaderGenerator(last);
            return shaderGenerator;
        },

        _applyAttributeMapStateSet: function(_attributeArray, stateSetAttributeArray) {
            var max =
                _attributeArray.length > stateSetAttributeArray.length
                    ? _attributeArray.length
                    : stateSetAttributeArray.length;

            for (var i = 0, l = max; i < l; i++) {
                var attribute;
                var attributeId = i;

                var attributeStack =
                    attributeId < _attributeArray.length ? _attributeArray[attributeId] : undefined;

                var stateSetAttributePair =
                    attributeId < stateSetAttributeArray.length
                        ? stateSetAttributeArray[attributeId]
                        : undefined;

                var hasStateAttributeStack = !!attributeStack;
                var hasStateAttributeStackChanged =
                    hasStateAttributeStack && attributeStack._changed;

                if (!stateSetAttributePair && !hasStateAttributeStackChanged) continue;

                var stateSetAttribute = stateSetAttributePair
                    ? stateSetAttributePair.getAttribute()
                    : undefined;

                if (!hasStateAttributeStack) {
                    attributeStack = this._createAttributeStack(
                        _attributeArray,
                        attributeId,
                        stateSetAttribute.cloneType()
                    );
                    attributeStack._changed = true;
                    this._applyAttributeStack(stateSetAttribute, attributeStack);
                } else if (stateSetAttribute) {
                    var maskValue = stateSetAttributePair.getValue();
                    attribute = this._evaluateOverrideObjectOnStack(
                        attributeStack,
                        stateSetAttribute,
                        maskValue
                    );
                    if (attribute !== stateSetAttribute) {
                        // override

                        if (attributeStack._changed) {
                            this._applyAttributeStack(attribute, attributeStack);
                            attributeStack._changed = false;
                        }
                    } else if (this._applyAttributeStack(attribute, attributeStack)) {
                        attributeStack._changed = true;
                    }
                } else if (attributeStack._length) {
                    attributeStack._changed = false;
                    this._applyAttributeStack(attributeStack._back.object, attributeStack);
                } else {
                    attributeStack._changed = false;
                    this._applyAttributeStack(attributeStack._globalDefault, attributeStack);
                }
            }
        },

        _applyTextureAttributeMapListStateSet: function(
            _textureAttributeArrayList,
            stateSetTextureAttributeArrayList
        ) {
            var _textureAttributeArray;
            var stateSetTextureAttributeLength, stateTextureAttributeLength;
            // very interesting JIT optimizer behavior
            // max texture is supposed to be the max of activeTexture or stateSet texture list
            // if the loop is fix, for example max value that could be 16. It's faster than using the max of textureUnit of State and StateSet even if the value is 8 for example
            var maxTexture = 16;
            for (var i = 0, l = maxTexture; i < l; i++) {
                var textureUnit = i;

                _textureAttributeArray =
                    textureUnit < _textureAttributeArrayList.length
                        ? _textureAttributeArrayList[textureUnit]
                        : undefined;
                var stateSetTextureAttributeArray =
                    textureUnit < stateSetTextureAttributeArrayList.length
                        ? stateSetTextureAttributeArrayList[textureUnit]
                        : undefined;

                if (!_textureAttributeArray && !stateSetTextureAttributeArray) continue;

                stateSetTextureAttributeLength = stateTextureAttributeLength = 0;
                if (!_textureAttributeArray) {
                    _textureAttributeArray = this.getOrCreateTextureAttributeArray(textureUnit);
                    stateSetTextureAttributeLength = stateSetTextureAttributeArray.length;
                } else {
                    stateTextureAttributeLength = _textureAttributeArray.length;
                    if (stateSetTextureAttributeArray)
                        stateSetTextureAttributeLength = stateSetTextureAttributeArray.length;
                }

                var lt =
                    stateTextureAttributeLength > stateSetTextureAttributeLength
                        ? stateTextureAttributeLength
                        : stateSetTextureAttributeLength;
                for (var j = 0; j < lt; j++) {
                    var attributeId = j;

                    var attributeStack =
                        attributeId < stateTextureAttributeLength
                            ? _textureAttributeArray[attributeId]
                            : undefined;

                    var stateSetAttributePair =
                        stateSetTextureAttributeArray &&
                        attributeId < stateSetTextureAttributeArray.length
                            ? stateSetTextureAttributeArray[attributeId]
                            : undefined;
                    var hasStateAttributeStack = !!attributeStack;
                    var hasStateAttributeStackChanged =
                        hasStateAttributeStack && attributeStack._changed;
                    var attribute;

                    if (!stateSetAttributePair && !hasStateAttributeStackChanged) continue;

                    var stateSetAttribute = stateSetAttributePair
                        ? stateSetAttributePair.getAttribute()
                        : undefined;

                    if (!hasStateAttributeStack) {
                        attribute = stateSetAttributePair.getAttribute();
                        attributeStack = this._createAttributeStack(
                            _textureAttributeArray,
                            attributeId,
                            attribute.cloneType()
                        );
                        attributeStack._changed = true;
                        this._applyTextureAttribute(textureUnit, attribute, attributeStack);
                    } else if (stateSetAttribute) {
                        var maskValue = stateSetAttributePair.getValue();
                        attribute = this._evaluateOverrideObjectOnStack(
                            attributeStack,
                            stateSetAttribute,
                            maskValue
                        );
                        if (attribute !== stateSetAttribute) {
                            // override

                            if (attributeStack._changed) {
                                this._applyTextureAttribute(textureUnit, attribute, attributeStack);
                                attributeStack._changed = false;
                            }
                        } else if (
                            this._applyTextureAttribute(textureUnit, attribute, attributeStack)
                        ) {
                            attributeStack._changed = true;
                        }
                    } else if (attributeStack._length) {
                        attributeStack._changed = false;
                        this._applyTextureAttribute(
                            textureUnit,
                            attributeStack._back.object,
                            attributeStack
                        );
                    } else {
                        attributeStack._changed = false;
                        this._applyTextureAttribute(
                            textureUnit,
                            attributeStack._globalDefault,
                            attributeStack
                        );
                    }
                }
            }
        },

        applyStateSet: function(stateset) {
            this._numApply++;

            var previousProgram = this.getLastProgramApplied();

            // needed before calling applyAttributeMap because
            // we cache needed StateAttribute from the compiler
            this._currentShaderGenerator = this.getCurrentShaderGeneratorStateSet(stateset);

            this._applyAttributeMapStateSet(this._attributeArray, stateset._attributeArray);
            this._applyTextureAttributeMapListStateSet(
                this._textureAttributeArrayList,
                stateset._textureAttributeArrayList
            );

            var lastApplied;
            if (this._currentShaderGenerator) {
                // no custom program look into the stack of ShaderGenerator name
                // what we should use to generate a program
                var generatedProgram = this._currentShaderGenerator.getOrCreateProgram(this);
                this.applyAttribute(generatedProgram);
                lastApplied = generatedProgram;

                // will cache uniform and apply them with the program
                this._applyGeneratedProgramUniforms(generatedProgram, stateset);
            } else {
                lastApplied = this.getLastProgramApplied();
                // custom program so we will iterate on uniform from the program and apply them
                // but in order to be able to use Attribute in the state graph we will check if
                // our program want them. It must be defined by the user
                this._applyCustomProgramUniforms(lastApplied, stateset);
            }

            // reset reference of last applied matrix
            if (previousProgram !== lastApplied) {
                this._lastAppliedModelViewMatrix = undefined;
                this._lastAppliedProjectionMatrix = undefined;
            }
        },

        popAllStateSets: function() {
            while (this._stateSets._length) {
                this.popStateSet();
            }
        },

        popStateSet: function() {
            if (!this._stateSets._length) return;

            var stateset = this._stateSets.pop();

            this.popAttributeMap(
                this._attributeArray,
                stateset._attributeArray,
                stateset._activeAttribute
            );

            var textureAttributeArrayList = stateset._textureAttributeArrayList;
            var activeTextureUnits = stateset._activeTextureAttributeUnit;
            var activeTextureAttribute = stateset._activeTextureAttribute;

            for (var i = 0, l = activeTextureUnits.length; i < l; i++) {
                var unit = activeTextureUnits[i];
                var _attributeArray = textureAttributeArrayList[unit];
                var textureUnitAttributeArray = this._textureAttributeArrayList[unit];
                this.popAttributeMap(
                    textureUnitAttributeArray,
                    _attributeArray,
                    activeTextureAttribute
                );
            }

            if (stateset.hasUniform())
                this.popUniformsList(this._uniforms, stateset.getUniformList());

            if (stateset.getShaderGeneratorPair()) {
                this._shaderGeneratorNames.pop();
            }
        },

        _createAttributeStack: function(_attributeArray, typeIndex, globalDefault) {
            utils.arrayDense(typeIndex, _attributeArray);
            var attributeStack = new StackObjectPairPool();
            attributeStack._globalDefault = globalDefault;

            _attributeArray[typeIndex] = attributeStack;

            return attributeStack;
        },

        haveAppliedAttribute: function(attribute) {
            if (!attribute) return;

            var attributeArray = this._attributeArray;
            var index = utils.getOrCreateStateAttributeTypeMemberIndex(attribute);
            var attributeStack = index < attributeArray.length ? attributeArray[index] : undefined;
            if (!attributeStack) {
                attributeStack = this._createAttributeStack(
                    attributeArray,
                    index,
                    attribute.cloneType()
                );
            }
            attributeStack._lastApplied = attribute;
            attributeStack._changed = true;
        },

        applyAttribute: function(attribute) {
            var index = utils.getOrCreateStateAttributeTypeMemberIndex(attribute);

            var attributeArray = this._attributeArray;
            var attributeStack = index < attributeArray.length ? attributeArray[index] : undefined;
            if (!attributeStack) {
                attributeStack = this._createAttributeStack(
                    attributeArray,
                    index,
                    attribute.cloneType()
                );
            }

            attributeStack._changed = true;
            this._applyAttributeStack(attribute, attributeStack);
        },

        _applyAttributeStack: function(attribute, attributeStack) {
            if (attributeStack._lastApplied === attribute) return false;

            if (attribute.apply) attribute.apply(this);

            attributeStack._lastApplied = attribute;
            return true;
        },

        _applyTextureAttribute: function(unit, attribute, attributeStack) {
            if (attributeStack._lastApplied === attribute) return false;

            attributeStack._lastApplied = attribute;

            if (!attribute.apply) return true;

            var gl = this.getGraphicContext();
            gl.activeTexture(gl.TEXTURE0 + unit);

            // there is a texture we bind it.
            attribute.apply(this, unit);

            return true;
        },

        applyTextureAttribute: function(unit, attribute) {
            var index = utils.getOrCreateTextureStateAttributeTypeMemberIndex(attribute);
            var textureUnitAttributeArray = this.getOrCreateTextureAttributeArray(unit);
            var attributeStack = textureUnitAttributeArray[index];

            if (!attributeStack)
                attributeStack = this._createAttributeStack(
                    textureUnitAttributeArray,
                    index,
                    attribute.cloneType()
                );

            attributeStack._changed = true;
            this._applyTextureAttribute(unit, attribute, attributeStack);
        },

        getLastProgramApplied: function() {
            return this._programAttribute._lastApplied;
        },

        applyDefault: function() {
            this.popAllStateSets();

            this._currentShaderGenerator = undefined;

            this.applyAttributeMap(this._attributeArray);
            this.applyTextureAttributeMapList(this._textureAttributeArrayList);
        },

        applyAttributeMap: function(_attributeArray) {
            var attributeStack;
            for (var i = 0, l = _attributeArray.length; i < l; i++) {
                attributeStack = _attributeArray[i];
                if (!attributeStack) continue;

                var attribute;
                if (attributeStack._length) attribute = attributeStack._back.object;
                else attribute = attributeStack._globalDefault;

                if (!attributeStack._changed) continue;

                if (attributeStack._lastApplied !== attribute) {
                    if (attribute.apply) attribute.apply(this);

                    attributeStack._lastApplied = attribute;
                }

                attributeStack._changed = false;
            }
        },

        pushUniformsList: function(uniformMap, stateSetUniformMap) {
            /*jshint bitwise: false */
            var name;
            var uniform;

            for (var key in stateSetUniformMap) {
                var uniformPair = stateSetUniformMap[key];
                uniform = uniformPair.getUniform();
                name = uniform.getName();
                if (!uniformMap[name]) {
                    this._createAttributeStack(uniformMap, name, uniform);
                }

                this.pushCheckOverride(uniformMap[name], uniform, uniformPair.getValue());
            }
            /*jshint bitwise: true */
        },

        popUniformsList: function(uniformMap, stateSetUniformMap) {
            for (var key in stateSetUniformMap) {
                uniformMap[key].pop();
            }
        },

        applyTextureAttributeMapList: function(textureAttributeArrayList) {
            var gl = this._graphicContext;
            var textureAttributeArray;

            for (
                var textureUnit = 0, l = textureAttributeArrayList.length;
                textureUnit < l;
                textureUnit++
            ) {
                textureAttributeArray = textureAttributeArrayList[textureUnit];
                if (!textureAttributeArray) continue;

                for (var i = 0, lt = textureAttributeArray.length; i < lt; i++) {
                    var attributeStack = textureAttributeArray[i];

                    // skip if not stack or not changed in stack
                    if (!attributeStack) continue;

                    var attribute;
                    if (attributeStack._length) attribute = attributeStack._back.object;
                    else attribute = attributeStack._globalDefault;

                    if (!attributeStack._changed) continue;

                    // if the the stack has changed but the last applied attribute is the same
                    // then we dont need to apply it again
                    if (attributeStack._lastApplied !== attribute) {
                        gl.activeTexture(gl.TEXTURE0 + textureUnit);
                        attribute.apply(this, textureUnit);

                        attributeStack._lastApplied = attribute;
                    }

                    attributeStack._changed = false;
                }
            }
        },

        setGlobalDefaultAttribute: function(attribute) {
            var index = utils.getOrCreateStateAttributeTypeMemberIndex(attribute);
            if (index >= this._attributeArray.length || !this._attributeArray[index]) {
                this._createAttributeStack(this._attributeArray, index, attribute);
            } else {
                this._attributeArray[index]._globalDefault = attribute;
            }
        },

        getGlobalDefaultAttribute: function(typeMember) {
            var _attributeArray = this._attributeArray;
            var index = utils.getIdFromTypeMember(typeMember);
            if (index === undefined || index >= _attributeArray.length) return undefined;
            return _attributeArray[index] ? _attributeArray[index]._globalDefault : undefined;
        },

        setGlobalDefaultTextureAttribute: function(unit, attribute) {
            var attributeArray = this.getOrCreateTextureAttributeArray(unit);
            var index = utils.getOrCreateTextureStateAttributeTypeMemberIndex(attribute);

            if (index >= attributeArray.length || !attributeArray[index]) {
                this._createAttributeStack(attributeArray, index, attribute);
            } else {
                attributeArray[index]._globalDefault = attribute;
            }
        },

        getGlobalDefaultTextureAttribute: function(unit, typeMember) {
            var attributeArray = this.getOrCreateTextureAttributeArray(unit);
            var index = utils.getTextureIdFromTypeMember(typeMember);
            if (index === undefined || index >= attributeArray.length) return undefined;
            return attributeArray[index] ? attributeArray[index]._globalDefault : undefined;
        },

        getOrCreateTextureAttributeArray: function(unit) {
            utils.arrayDense(unit, this._textureAttributeArrayList);

            if (!this._textureAttributeArrayList[unit]) this._textureAttributeArrayList[unit] = [];
            return this._textureAttributeArrayList[unit];
        },

        pushAttributeMap: function(_attributeArray, stateSetAttributeArray, validAttributeArray) {
            /*jshint bitwise: false */
            var attributeStack;
            var stateSetAttributeArrayLength = stateSetAttributeArray.length;
            var _attributeArrayLength = _attributeArray.length;
            for (var i = 0, l = validAttributeArray.length; i < l; i++) {
                var index = validAttributeArray[i];
                var attributePair =
                    index < stateSetAttributeArrayLength
                        ? stateSetAttributeArray[index]
                        : undefined;
                var attribute = attributePair.getAttribute();

                attributeStack = index < _attributeArrayLength ? _attributeArray[index] : undefined;
                if (!attributeStack) {
                    attributeStack = this._createAttributeStack(
                        _attributeArray,
                        index,
                        attribute.cloneType()
                    );
                }

                this.pushCheckOverride(attributeStack, attribute, attributePair.getValue());
                attributeStack._changed = true;
            }
        },

        popAttributeMap: function(_attributeArray, stateSetAttributeArray, activeAttribute) {
            for (var i = 0, l = activeAttribute.length; i < l; i++) {
                var index = activeAttribute[i];
                var attributeStack = _attributeArray[index];

                attributeStack.pop();
                attributeStack._changed = true;
            }
        },

        setIndexArray: function(array) {
            var gl = this._graphicContext;

            if (this._currentIndexVBO !== array) {
                array.bind(gl);
                this._currentIndexVBO = array;
            }

            if (array.isDirty()) {
                array.compile(gl);
            }
        },

        lazyDisablingOfVertexAttributes: function() {
            var keys = this._vertexAttribMap._keys;
            for (var i = 0, l = keys.length; i < l; i++) {
                var attr = keys[i];
                if (this._vertexAttribMap[attr]) {
                    this._vertexAttribMap._disable[attr] = true;
                }
            }
        },

        enableVertexColor: function() {
            var program = this._programAttribute._lastApplied;

            if (
                !program.getUniformsCache().uArrayColorEnabled ||
                !program.getAttributesCache().Color
            )
                return; // no color uniform or attribute used, exit

            // update uniform
            var uniform = this._uniforms.ArrayColorEnabled._globalDefault;

            var previousColorEnabled = this._previousColorAttribPair[program.getInstanceID()];

            if (!previousColorEnabled) {
                uniform.setFloat(1.0);
                uniform.apply(
                    this.getGraphicContext(),
                    program.getUniformsCache().uArrayColorEnabled
                );
                this._previousColorAttribPair[program.getInstanceID()] = true;
            }
        },

        disableVertexColor: function() {
            var program = this._programAttribute._lastApplied;

            if (
                !program.getUniformsCache().uArrayColorEnabled ||
                !program.getAttributesCache().Color
            )
                return; // no color uniform or attribute used, exit

            // update uniform
            var uniform = this._uniforms.ArrayColorEnabled._globalDefault;

            var previousColorEnabled = this._previousColorAttribPair[program.getInstanceID()];

            if (previousColorEnabled) {
                uniform.setFloat(0.0);
                uniform.apply(
                    this.getGraphicContext(),
                    program.getUniformsCache().uArrayColorEnabled
                );
                this._previousColorAttribPair[program.getInstanceID()] = false;
            }
        },

        applyDisablingOfVertexAttributes: function() {
            var keys = this._vertexAttribMap._keys;
            for (var i = 0, l = keys.length; i < l; i++) {
                if (this._vertexAttribMap._disable[keys[i]] === true) {
                    var attr = keys[i];
                    this._graphicContext.disableVertexAttribArray(attr);
                    this._vertexAttribMap._disable[attr] = false;
                    this._vertexAttribMap[attr] = false;
                }
            }
        },

        clearVertexAttribCache: function() {
            var vertexAttribMap = this._vertexAttribMap;
            var keys = vertexAttribMap._keys;
            for (var i = 0, l = keys.length; i < l; i++) {
                var attr = keys[i];
                vertexAttribMap[attr] = undefined;
                vertexAttribMap._disable[attr] = false;
            }

            this._vertexAttribMap._disable.length = 0;
            this._vertexAttribMap._keys.length = 0;
        },

        /**
         *  set a vertex array object.
         *  return true if binded the vao and false
         *  if was already binded
         */
        setVertexArrayObject: function(vao) {
            if (this._currentVAO === vao) return false;

            this._currentVAO = vao;

            if (vao) {
                vao.bind(this._graphicContext);
            } else {
                // disable cache to force a re enable of array
                this._graphicContext.bindVertexArray(null);
                this.clearVertexAttribCache();
            }

            // disable currentIndexVBO to force to bind indexArray from Geometry
            // if there is a change of vao
            this._currentIndexVBO = undefined;

            return true;
        },

        setVertexAttribArray: function(attrib, array, normalize, divisor) {
            var vertexAttribMap = this._vertexAttribMap;
            vertexAttribMap._disable[attrib] = false;
            var gl = this._graphicContext;
            var binded = false;

            if (array.isDirty()) {
                array.bind(gl);
                array.compile(gl);
                binded = true;
            }

            var currentArray = vertexAttribMap[attrib];
            if (currentArray !== array) {
                if (!binded) {
                    array.bind(gl);
                }

                if (!currentArray) {
                    gl.enableVertexAttribArray(attrib);

                    // can be === false (so undefined check is important)
                    if (currentArray === undefined) vertexAttribMap._keys.push(attrib);
                }

                vertexAttribMap[attrib] = array;
                
                var type = array.getType();
                var isWebgl2 = WebGLCaps.instance().isWebGL2();
                if (isWebgl2 && (type === gl.INT || type == gl.UNSIGNED_INT)) {
                  gl.vertexAttribIPointer(
                      attrib, // index
                      array.getItemSize(), // size
                      type, // type
                      0, // stride
                      0 // offset
                  );
                }
                else {
                  gl.vertexAttribPointer(
                      attrib, // index
                      array.getItemSize(), // size
                      type, // type
                      normalize, // normalized
                      0, // stride
                      0  // offset
                  );
                }
                if (divisor !== undefined) {
                    if (isWebgl2) {
                        gl.vertexAttribDivisor(attrib, divisor);
                    }
                    else {
                        var ext = WebGLCaps.instance(gl).getWebGLExtension('ANGLE_instanced_arrays');
                        if (!ext) {
                            notify.error('Your browser does not support instanced arrays');
                        }
                        ext.vertexAttribDivisorANGLE(attrib, divisor);
                    }
                }
            }
        },

        _getActiveUniformsFromProgramAttributes: function(program, activeUniformsList) {
            var _attributeArrayStack = this._attributeArray;

            var attributeKeys = program.getTrackAttributes().attributeKeys;

            if (attributeKeys.length > 0) {
                for (var i = 0, l = attributeKeys.length; i < l; i++) {
                    var key = attributeKeys[i];
                    var index = this.typeMember[key];
                    var attributeStack = _attributeArrayStack[index];
                    if (!attributeStack) {
                        continue;
                    }

                    // we just need the uniform list and not the attribute itself
                    var attribute = attributeStack._globalDefault;
                    if (!attribute.getOrCreateUniforms) {
                        continue;
                    }

                    var uniformMap = attribute.getOrCreateUniforms();
                    for (var keyUniform in uniformMap) {
                        activeUniformsList.push(uniformMap[keyUniform]);
                    }
                }
            }
        },

        _getActiveUniformsFromProgramTextureAttributes: function(program, activeUniformsList) {
            var textureAttributeKeysList = program.getTrackAttributes().textureAttributeKeys;
            if (!textureAttributeKeysList) return;

            for (var unit = 0, nbUnit = textureAttributeKeysList.length; unit < nbUnit; unit++) {
                var textureAttributeKeys = textureAttributeKeysList[unit];
                if (!textureAttributeKeys) continue;

                var unitTextureAttributeList = this._textureAttributeArrayList[unit];
                if (!unitTextureAttributeList) continue;

                for (var i = 0, l = textureAttributeKeys.length; i < l; i++) {
                    var key = textureAttributeKeys[i];

                    var attributeStack = unitTextureAttributeList[key];
                    if (!attributeStack) {
                        continue;
                    }
                    // we just need the uniform list and not the attribute itself
                    var attribute = attributeStack._globalDefault;
                    if (!attribute.getOrCreateUniforms) {
                        continue;
                    }
                    var uniformMap = attribute.getOrCreateUniforms();
                    for (var keyUniform in uniformMap) {
                        activeUniformsList.push(uniformMap[keyUniform]);
                    }
                }
            }
        },

        _cacheUniformsForCustomProgram: function(program, activeUniformsList) {
            this._getActiveUniformsFromProgramAttributes(program, activeUniformsList);

            this._getActiveUniformsFromProgramTextureAttributes(program, activeUniformsList);

            var gl = this._graphicContext;

            // now we have a list on uniforms we want to track but we will filter them to use only what is needed by our program
            // not that if you create a uniforms whith the same name of a tracked attribute, and it will override it
            var uniformsFinal = {};

            for (var i = 0, l = activeUniformsList.length; i < l; i++) {
                var u = activeUniformsList[i];
                var uniformName = u.getName();
                var loc = gl.getUniformLocation(program._program, uniformName);
                if (loc !== undefined && loc !== null) {
                    uniformsFinal[uniformName] = u;
                }
            }
            program.trackUniforms = uniformsFinal;
        },

        _applyCustomProgramUniforms: (function() {
            var activeUniformsList = [];

            return function(program, stateset) {
                // custom program so we will iterate on uniform from the program and apply them
                // but in order to be able to use Attribute in the state graph we will check if
                // our program want them. It must be defined by the user

                // first time we see attributes key, so we will keep a list of uniforms from attributes
                activeUniformsList.length = 0;

                // fill the program with cached active uniforms map from attributes and texture attributes
                if (
                    program.getTrackAttributes() !== undefined &&
                    program.trackUniforms === undefined
                ) {
                    this._cacheUniformsForCustomProgram(program, activeUniformsList);
                }

                var programUniformMap = program.getUniformsCache();
                var uniformMapStack = this._uniforms;

                var programTrackUniformMap;
                if (program.trackUniforms) programTrackUniformMap = program.trackUniforms;

                var uniform;
                for (var uniformName in programUniformMap) {
                    var location = programUniformMap[uniformName];
                    var uniformStack = uniformMapStack[uniformName];

                    var hasStateSetUniformPair = stateset && stateset.uniforms[uniformName];

                    if (!uniformStack && !hasStateSetUniformPair) {
                        if (programTrackUniformMap === undefined) {
                            this._checkErrorUniform(uniformName);
                            continue;
                        }

                        uniform = programTrackUniformMap[uniformName];
                    } else if (hasStateSetUniformPair) {
                        var stateSetUniformPair = stateset.uniforms[uniformName];
                        var maskValue = stateSetUniformPair.getValue();
                        var stateSetUniform = stateSetUniformPair.getUniform();
                        if (uniformStack)
                            uniform = this._evaluateOverrideObjectOnStack(
                                uniformStack,
                                stateSetUniform,
                                maskValue
                            );
                        else uniform = stateSetUniform;
                    } else if (uniformStack._length) {
                        uniform = uniformStack._back.object;
                    } else {
                        uniform = uniformStack._globalDefault;
                    }

                    uniform.apply(this._graphicContext, location);
                }
            };
        })(),

        _checkErrorUniform: function(uniformName) {
            var unit = uniformName.substr(7);
            if (this._textureAttributeArrayList[unit] && uniformName === 'Texture' + unit) {
                return;
            }

            if (this._excludeUniforms[uniformName]) {
                return;
            }

            this._excludeUniforms[uniformName] = 1; // avoid multiple spammy errors

            notify.error('Uniform not in the scene hierarchy : ' + uniformName);
        },

        _computeForeignUniforms: function(programUniformMap, activeUniformMap) {
            var foreignUniforms = [];

            for (var keyUniform in programUniformMap) {
                var location = programUniformMap[keyUniform];

                // filter 'standard' uniform matrix that will be applied for all shader
                if (location !== undefined && activeUniformMap[keyUniform] === undefined) {
                    if (!this._excludeUniforms[keyUniform]) {
                        foreignUniforms.push(keyUniform);
                    }
                }
            }

            return foreignUniforms;
        },

        _removeUniformsNotRequiredByProgram: function(activeUniformMap, programUniformMap) {
            for (var keyUniform in activeUniformMap) {
                var location = programUniformMap[keyUniform];
                if (location === undefined || location === null) {
                    delete activeUniformMap[keyUniform];
                }
            }
        },

        _cacheUniformsForGeneratedProgram: function(program) {
            var shaderUniforms = program.getUniformsCache(); // declared in the shader
            var stateSetUniforms = program.getActiveUniforms(); // present in last stateset

            var foreignUniforms = this._computeForeignUniforms(shaderUniforms, stateSetUniforms);
            program.setForeignUniforms(foreignUniforms);

            // remove uniforms listed by attributes (getActiveUniforms) but not required by the program
            this._removeUniformsNotRequiredByProgram(stateSetUniforms, shaderUniforms);
        },

        _copyUniformEntry: function(uniform) {
            var internalArray = uniform.getInternalArray();
            var cacheData;
            if (internalArray.length < 16) {
                cacheData = new internalArray.constructor(internalArray.length);
            }

            return cacheData;
        },

        _initUniformCache: function(program) {
            var activeUniformMap = program.getActiveUniforms();

            var foreignUniformKeys = program.getForeignUniforms();
            var uniformMapStack = this._uniforms;

            var cacheForeignUniforms = [];
            var cacheActiveUniforms = [];

            var i, l, cache, name, cacheData, uniform;

            program._cacheUniformId = this._cacheUniformId++;
            this._programUniformCache[program._cacheUniformId] = {};

            if (foreignUniformKeys.length) {
                cache = cacheForeignUniforms;
                for (i = 0, l = foreignUniformKeys.length; i < l; i++) {
                    name = foreignUniformKeys[i];
                    var uniStack = uniformMapStack[name];
                    // Always reserve a slot so cache indices stay aligned with foreignUniformKeys,
                    // even for a uniform that does not exist yet (filled on first apply).
                    cache.push(uniStack ? this._copyUniformEntry(uniStack._globalDefault) : undefined);
                }
            }

            for (var keyUniform in activeUniformMap) {
                uniform = activeUniformMap[keyUniform];
                cacheData = this._copyUniformEntry(uniform);
                cacheActiveUniforms.push(cacheData);
            }

            this._programUniformCache[program._cacheUniformId].foreign = cacheForeignUniforms;
            this._programUniformCache[program._cacheUniformId].active = cacheActiveUniforms;
        },

        _checkCacheAndApplyUniform: function(
            uniform,
            cacheArray,
            indexCache,
            programUniformMap,
            nameUniform
        ) {
            var isCached;
            var internalArray = uniform.getInternalArray();
            var uniformArrayLength = internalArray.length;
            if (uniformArrayLength <= 4) {
                var uniformCache = cacheArray[indexCache];
                if (uniformCache === undefined) {
                    uniformCache = cacheArray[indexCache] = this._copyUniformEntry(uniform);
                }
                isCached = checkUniformCache[uniformArrayLength](internalArray, uniformCache);
            } else {
                isCached = false;
            }

            if (!isCached) {
                var location = programUniformMap[nameUniform];
                uniform.apply(this._graphicContext, location);
            }
        },

        // note that about TextureAttribute that need uniform on unit we would need to improve
        // the current uniformList ...

        // when we apply the shader for the first time, we want to compute the active uniforms for this shader and the list of uniforms not extracted from attributes called foreignUniforms
        _applyGeneratedProgramUniforms: function(program, stateset) {
            var uniformMapStack = this._uniforms;
            var uniform, uniformName, uniformStack, i;

            var foreignUniformKeys = program.getForeignUniforms();
            if (!foreignUniformKeys) {
                this._cacheUniformsForGeneratedProgram(program);
                foreignUniformKeys = program.getForeignUniforms();

                // be sure to create a stack for foreign uniform for this program
                // it's needed to do it here because of the cache of uniform
                if (stateset) {
                    var stateSetUniforms = stateset.uniforms;
                    for (i = 0; i < foreignUniformKeys.length; i++) {
                        uniformName = foreignUniformKeys[i];

                        // already exist
                        if (uniformMapStack[uniformName]) continue;

                        // does not exist check to initialize with stateSet uniforms
                        if (!stateSetUniforms[uniformName]) continue;

                        uniform = stateSetUniforms[uniformName].getUniform();
                        this._createAttributeStack(uniformMapStack, uniformName, uniform);
                    }
                }

                this._initUniformCache(program);
            }

            var programUniformMap = program.getUniformsCache();
            var activeUniformMap = program.getActiveUniforms();

            var cacheUniformsActive = this._programUniformCache[program._cacheUniformId].active;
            var cacheUniformsForeign = this._programUniformCache[program._cacheUniformId].foreign;

            // apply active uniforms
            // caching uniforms from attribtues make it impossible to overwrite uniform with a custom uniform instance not used in the attributes
            var indexCache = 0;
            for (var keyUniform in activeUniformMap) {
                uniform = activeUniformMap[keyUniform];
                this._checkCacheAndApplyUniform(
                    uniform,
                    cacheUniformsActive,
                    indexCache,
                    programUniformMap,
                    keyUniform
                );
                indexCache++; // TODO not good, for in ordered consistency, etc...
            }

            // apply now foreign uniforms, it's uniforms needed by the program but not contains in attributes used to generate this program
            indexCache = 0;
            var nbForeigns = foreignUniformKeys.length;
            for (i = 0; i < nbForeigns; i++) {
                uniformName = foreignUniformKeys[i];

                uniformStack = uniformMapStack[uniformName];
                var hasStateSetUniformPair = stateset && stateset.uniforms[uniformName];

                if (!hasStateSetUniformPair && !uniformStack) {
                    this._checkErrorUniform(uniformName);
                    indexCache++;
                    continue;
                }

                if (hasStateSetUniformPair) {
                    var stateSetUniformPair = stateset.uniforms[uniformName];
                    var maskValue = stateSetUniformPair.getValue();
                    var stateSetUniform = stateSetUniformPair.getUniform();
                    uniform = this._evaluateOverrideObjectOnStack(
                        uniformStack,
                        stateSetUniform,
                        maskValue
                    );
                } else if (uniformStack._length) {
                    uniform = uniformStack._back.object;
                } else {
                    uniform = uniformStack._globalDefault;
                    this._checkErrorUniform(uniformName);
                }

                this._checkCacheAndApplyUniform(
                    uniform,
                    cacheUniformsForeign,
                    indexCache,
                    programUniformMap,
                    uniformName
                );
                indexCache++;
            }
        },

        // Use to detect changes in RenderLeaf between call to avoid to applyStateSet
        _setStateSetsDrawID: function(id) {
            var values = this._stateSets.getArray();
            for (var i = 0, nbStateSets = this._stateSets.length; i < nbStateSets; i++) {
                values[i].setDrawID(id);
            }
        },

        _stateSetStackChanged: function(id, nbLast) {
            var values = this._stateSets.getArray();
            var nbStateSets = this._stateSets.length;
            if (nbLast !== nbStateSets) return true;

            for (var i = 0; i < nbStateSets; i++) {
                if (id !== values[i].getDrawID()) return true;
            }

            return false;
        }
    }),
    'osg',
    'State'
);

/**
 * The number of texture coordinate units that can be shifted (see applyTexCoordShifts).
 * @type {number}
 */
State.MAX_TEXCOORD_SHIFT_UNITS = 8;

/**
 * The minimum absolute texture coordinate for a unit to be shifted (see applyTexCoordShifts).
 * Smaller coordinates are precise enough.
 * @type {number}
 */
State.MIN_TEXCOORD_SHIFT_MAGNITUDE = 256.0;

/**
 * The maximum deviation from the affine fit, in texture repeats, for a unit to be shifted. A
 * shift is an even integer, so a rough fit only makes the remaining coordinates larger.
 * @type {number}
 */
State.MAX_TEXCOORD_SHIFT_FIT_ERROR = 1.0;

/**
 * Returns the texture coordinate maps of a geometry, fitted on first use and cached on it: per unit
 * either an array [a, b, c, d, e, f] with u = a * x + b * y + c and v = d * x + e * y + f in the
 * vertex coordinates, or null if the unit is missing, small, or not such a function.
 * @param {osg.Geometry} geometry The geometry.
 * @returns {Array<Array<number>|null>} The maps per texture coordinate unit.
 */
State.getTexCoordShiftMaps = function(geometry) {
    var maps = geometry._texCoordShiftMaps;
    if (maps !== undefined) return maps;

    maps = [];
    var attributes = geometry.getVertexAttributeList();
    var vertexArray = attributes.Vertex;
    var vertices = vertexArray ? vertexArray.getElements() : undefined;
    for (var unit = 0; unit < State.MAX_TEXCOORD_SHIFT_UNITS; ++unit) {
        var texCoordArray = attributes['TexCoord' + unit];
        var texCoords = texCoordArray ? texCoordArray.getElements() : undefined;
        maps.push(
            vertices && texCoords && vertexArray.getItemSize() >= 2 && texCoordArray.getItemSize() >= 2
                ? State._fitTexCoordShiftMap(
                      vertices,
                      vertexArray.getItemSize(),
                      texCoords,
                      texCoordArray.getItemSize()
                  )
                : null
        );
    }
    geometry._texCoordShiftMaps = maps;
    return maps;
};

/**
 * Fits texture coordinates as an affine function of the vertex X and Y, see getTexCoordShiftMaps.
 * @private
 */
State._fitTexCoordShiftMap = function(vertices, vertexSize, texCoords, texCoordSize) {
    var n = Math.min(vertices.length / vertexSize, texCoords.length / texCoordSize);
    if (n < 3) return null;

    // Only large coordinates need shifting
    var maxMagnitude = 0.0;
    var i;
    for (i = 0; i < n; ++i) {
        maxMagnitude = Math.max(
            maxMagnitude,
            Math.abs(texCoords[i * texCoordSize]),
            Math.abs(texCoords[i * texCoordSize + 1])
        );
    }
    if (maxMagnitude < State.MIN_TEXCOORD_SHIFT_MAGNITUDE) return null;

    // Three vertices spanning a large triangle in X and Y: the first, the farthest from it, and the
    // farthest from the line between them
    var x0 = vertices[0];
    var y0 = vertices[1];
    var i1 = 0;
    var best = 0.0;
    var dx;
    var dy;
    for (i = 1; i < n; ++i) {
        dx = vertices[i * vertexSize] - x0;
        dy = vertices[i * vertexSize + 1] - y0;
        if (dx * dx + dy * dy > best) {
            best = dx * dx + dy * dy;
            i1 = i;
        }
    }
    var x1 = vertices[i1 * vertexSize] - x0;
    var y1 = vertices[i1 * vertexSize + 1] - y0;
    var i2 = 0;
    best = 0.0;
    for (i = 1; i < n; ++i) {
        var cross = Math.abs(x1 * (vertices[i * vertexSize + 1] - y0) - y1 * (vertices[i * vertexSize] - x0));
        if (cross > best) {
            best = cross;
            i2 = i;
        }
    }
    var x2 = vertices[i2 * vertexSize] - x0;
    var y2 = vertices[i2 * vertexSize + 1] - y0;
    var det = x1 * y2 - x2 * y1;
    if (!(Math.abs(det) > 1e-6 * (x1 * x1 + y1 * y1))) return null;

    // Solve per component, relative to the first vertex
    var map = [];
    for (var c = 0; c < 2; ++c) {
        var t0 = texCoords[c];
        var t1 = texCoords[i1 * texCoordSize + c] - t0;
        var t2 = texCoords[i2 * texCoordSize + c] - t0;
        var a = (t1 * y2 - t2 * y1) / det;
        var b = (x1 * t2 - x2 * t1) / det;
        map.push(a, b, t0 - a * x0 - b * y0);
    }

    // Verify on all vertices
    for (i = 0; i < n; ++i) {
        var x = vertices[i * vertexSize];
        var y = vertices[i * vertexSize + 1];
        if (
            Math.abs(map[0] * x + map[1] * y + map[2] - texCoords[i * texCoordSize]) > State.MAX_TEXCOORD_SHIFT_FIT_ERROR ||
            Math.abs(map[3] * x + map[4] * y + map[5] - texCoords[i * texCoordSize + 1]) > State.MAX_TEXCOORD_SHIFT_FIT_ERROR
        ) {
            return null;
        }
    }
    return map;
};

export default State;
