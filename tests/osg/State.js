import { assert } from 'chai';
import Utils from 'osg/utils';
import State from 'osg/State';
import StateSet from 'osg/StateSet';
import Material from 'osg/Material';
import StateAttribute from 'osg/StateAttribute';
import Texture from 'osg/Texture';
import Depth from 'osg/Depth';
import ShaderGeneratorProxy from 'osgShader/ShaderGeneratorProxy';
import mockup from 'tests/mockup/mockup';
import { mat4 } from 'osg/glMatrix';
import { vec3 } from 'osg/glMatrix';

export default function() {
    test('State', function() {
        (function() {
            var state = new State(new ShaderGeneratorProxy());

            var stateSet0 = new StateSet();
            var stateSet1 = new StateSet();
            var stateSet2 = new StateSet();

            var material = new Material();
            stateSet0.setAttributeAndModes(material);
            stateSet1.setAttributeAndModes(new Material(), StateAttribute.OVERRIDE);
            stateSet2.setAttributeAndModes(new Material(), StateAttribute.OFF);

            state.pushStateSet(stateSet0);
            state.pushStateSet(stateSet1);
            state.pushStateSet(stateSet2);
            var materialStack =
                state._attributeArray[Utils.getOrCreateStateAttributeTypeMemberIndex(material)];
            assert.isOk(
                materialStack[materialStack.getLength() - 1] ===
                    materialStack[materialStack.getLength() - 2],
                'check Override in state'
            );
        })();
    });

    test('State resetCaches after a lost context applies the state again', function() {
        var state = new State(new ShaderGeneratorProxy());
        var enabled = [];
        var gl = {
            DEPTH_TEST: 0x0b71,
            enable: function(cap) {
                enabled.push(cap);
            },
            disable: function() {},
            depthFunc: function() {},
            depthRange: function() {}
        };

        var depth = new Depth(Depth.LESS);
        state.applyAttribute(depth);
        state._stateCache.applyDepth(gl);
        assert.deepEqual(enabled, [gl.DEPTH_TEST], 'Check depth test enabled');

        // The same depth attribute is not applied twice
        state.applyAttribute(depth);
        state._stateCache.applyDepth(gl);
        assert.deepEqual(enabled, [gl.DEPTH_TEST], 'Check depth test enabled once');

        // A restored context has the depth test disabled, so it must be enabled again
        state.resetCaches();
        state.applyAttribute(depth);
        state._stateCache.applyDepth(gl);
        assert.deepEqual(enabled, [gl.DEPTH_TEST, gl.DEPTH_TEST], 'Check depth test enabled again');
    });

    test('State setGlobalDefaultTextureAttribute', function() {
        var state = new State(new ShaderGeneratorProxy());

        var texture = new Texture();
        state.setGlobalDefaultTextureAttribute(0, texture);

        assert.equal(
            state.getGlobalDefaultTextureAttribute(0, 'Texture'),
            texture,
            'check texture object'
        );
    });

    test('State applyStateSet', function() {
        (function() {
            var state = new State(new ShaderGeneratorProxy());
            var fakeRenderer = mockup.createFakeRenderer();
            var id = 0;
            fakeRenderer.createProgram = function() {
                return id++;
            };
            fakeRenderer.getProgramParameter = function() {
                return true;
            };

            var textureBindCall = new Map();

            fakeRenderer.bindTexture = function(target, texture) {
                var value = textureBindCall.get(texture);
                if (value === undefined) value = 0;
                value++;
                textureBindCall.set(texture, value);
            };
            state.setGraphicContext(fakeRenderer);

            var stateSet0 = new StateSet();
            var stateSet1 = new StateSet();
            var stateSet2 = new StateSet();

            stateSet0.setAttributeAndModes(new Material());

            var texture0 = new Texture();
            texture0.setName('My name is 0');
            texture0.setTextureSize(1, 1);
            texture0._textureObject = {
                bind: function(gl) {
                    gl.bindTexture(0, 1);
                }
            };

            stateSet1.setTextureAttributeAndModes(0, texture0);

            stateSet2.setTextureAttributeAndModes(0, texture0);
            stateSet2.setTextureAttributeAndModes(1, new Texture());

            state.pushStateSet(stateSet0);
            state.applyStateSet(stateSet1);
            state.applyStateSet(stateSet2);

            assert.equal(state.getStateSetStackSize(), 1, 'check stateSet stack length');
            var program = state.getLastProgramApplied();
            assert.notEqual(program, undefined, 'check last program applied');
            assert.equal(state._programAttribute.getLength(), 0, 'check program stack length');

            // check that texture 0 is applied only once
            assert.equal(textureBindCall.get(1), 1, 'check that texture 0 is applied only once');
        })();
    });

    // Applies the model-view matrix with a mockup program subtracting the render origin, and returns
    // what the GPU would compute in 32-bit floats: modelView * (vertex - uRenderOrigin)
    // (one mockup context per state, since uniforms keep the functions of the first context)
    var applyWithRenderOrigin = function(state, origin, modelView, model, vertex) {
        if (!state._graphicContext) {
            state._uploadedForTest = {};
            state._graphicContext = {
                uniformMatrix4fv: function(location, transpose, data) {
                    state._uploadedForTest[location] = new Float32Array(data);
                },
                uniformMatrix3fv: function() {},
                uniform3fv: function(location, data) {
                    state._uploadedForTest[location] = new Float32Array(data);
                }
            };
        }
        var uploaded = state._uploadedForTest;
        state._programAttribute._lastApplied = {
            getUniformsCache: function() {
                return { uModelViewMatrix: 'modelView', uRenderOrigin: 'origin' };
            }
        };
        state.setRenderOrigin(origin);
        state._lastAppliedModelViewMatrix = undefined;
        state.applyModelViewMatrix(modelView, model);

        var local = vec3.fromValues(
            Math.fround(Math.fround(vertex[0]) - uploaded.origin[0]),
            Math.fround(Math.fround(vertex[1]) - uploaded.origin[1]),
            Math.fround(Math.fround(vertex[2]) - uploaded.origin[2])
        );
        return {
            local: local,
            view: vec3.transformMat4(vec3.create(), local, uploaded.modelView)
        };
    };

    test('State render origin keeps the transformed vertices precise far from the origin', function() {
        var state = new State(new ShaderGeneratorProxy());
        var eye = [350100.0, 319400.0, 20.0];
        var view = mat4.lookAt(mat4.create(), eye, [350123.0, 319456.0, 12.0], [0.0, 0.0, 1.0]);
        var origin = [350000.0, 319000.0, 0.0];

        // A model with large world coordinates in its vertices, e.g. terrain
        var model = mat4.create();
        var vertex = [350110.53125, 319430.25, 3.5];
        var expected = vec3.transformMat4(vec3.create(), vertex, view);
        var result = applyWithRenderOrigin(state, origin, view, model, vertex);
        assert.isBelow(vec3.distance(result.view, expected), 1e-4, 'check large vertex in view');

        // A rotated model with a large translation, e.g. an entity
        var entity = mat4.fromTranslation(mat4.create(), [350123.25, 319456.5, 12.0]);
        mat4.rotateZ(entity, entity, 0.4);
        var entityVertex = [1.5, -2.25, 0.75];
        var modelView = mat4.multiply(mat4.create(), view, entity);
        expected = vec3.transformMat4(vec3.create(), entityVertex, modelView);
        result = applyWithRenderOrigin(state, origin, modelView, entity, entityVertex);
        assert.isBelow(vec3.distance(result.view, expected), 1e-4, 'check entity vertex in view');

        // World positions are relative to the render origin, and the view matrix compensates for it
        var world = vec3.transformMat4(vec3.create(), result.local, state.getModelMatrixToApply(entity));
        var expectedWorld = vec3.sub(vec3.create(), vec3.transformMat4(vec3.create(), entityVertex, entity), origin);
        assert.isBelow(vec3.distance(world, expectedWorld), 1e-6, 'check world relative to render origin');
        var viewFromWorld = vec3.transformMat4(vec3.create(), world, state.getViewMatrixToApply(view));
        assert.isBelow(vec3.distance(viewFromWorld, expected), 1e-6, 'check view from relative world');

        // Programs not subtracting the render origin get the matrices unchanged
        state._programAttribute._lastApplied = {
            getUniformsCache: function() {
                return {};
            }
        };
        state._lastAppliedModelViewMatrix = undefined;
        state.applyModelViewMatrix(modelView, entity);
        assert.equal(state.getModelMatrixToApply(entity), entity, 'check model unchanged');
        assert.equal(state.getViewMatrixToApply(view), view, 'check view unchanged');
    });

    test('State texture coordinate shifts keep large repeating coordinates small near the render origin', function() {
        // A 192.4 km tile grid with a detail texture every 4 m (unit 1), a 0-1 texture (unit 0) and
        // large coordinates that are not affine in the position (unit 2)
        var vertices = [];
        var texCoords0 = [];
        var texCoords1 = [];
        var texCoords2 = [];
        for (var j = 0; j <= 4; ++j) {
            for (var i = 0; i <= 4; ++i) {
                var x = 192400 + i * 48100;
                var y = j * 48100;
                vertices.push(x, y, 0.0);
                texCoords0.push(i / 4, j / 4);
                texCoords1.push(x / 4, y / 4 + 0.5);
                texCoords2.push(x * x / 1e6, y);
            }
        }
        var attribute = function(elements, itemSize) {
            return {
                getElements: function() {
                    return new Float32Array(elements);
                },
                getItemSize: function() {
                    return itemSize;
                }
            };
        };
        var attributes = {
            Vertex: attribute(vertices, 3),
            TexCoord0: attribute(texCoords0, 2),
            TexCoord1: attribute(texCoords1, 2),
            TexCoord2: attribute(texCoords2, 2)
        };
        var geometry = {
            getVertexAttributeList: function() {
                return attributes;
            }
        };

        var maps = State.getTexCoordShiftMaps(geometry);
        assert.equal(maps[0], null, 'check small coordinates not shifted');
        assert.ok(maps[1], 'check detail coordinates fitted');
        assert.equal(maps[2], null, 'check non-affine coordinates not shifted');
        assert.equal(State.getTexCoordShiftMaps(geometry), maps, 'check maps cached');

        var applied = {};
        var state = new State(new ShaderGeneratorProxy());
        state._graphicContext = {
            uniform2f: function(location, u, v) {
                applied[location] = [u, v];
            }
        };
        var shiftUniforms = [
            { unit: 0, location: 'l0', u: NaN, v: NaN },
            { unit: 1, location: 'l1', u: NaN, v: NaN }
        ];

        // At the world origin, nothing is shifted
        state.applyTexCoordShifts(shiftUniforms, geometry, undefined);
        assert.deepEqual(applied.l1, [0, 0], 'check no shift at the world origin');

        // Far from it, the detail coordinates get an even shift near those at the render origin
        state.setRenderOrigin(vec3.fromValues(348660, 319310, 0));
        state.applyTexCoordShifts(shiftUniforms, geometry, undefined);
        assert.deepEqual(applied.l0, [0, 0], 'check unit 0 not shifted');
        assert.equal(applied.l1[0] % 2, 0, 'check even shift u');
        assert.equal(applied.l1[1] % 2, 0, 'check even shift v');
        assert.ok(Math.abs(348660 / 4 - applied.l1[0]) <= 1, 'check shift u near the render origin');
        assert.ok(Math.abs(319310 / 4 + 0.5 - applied.l1[1]) <= 1, 'check shift v near the render origin');

        // A model matrix translating the geometry moves the render origin in its coordinates
        var model = mat4.fromTranslation(mat4.create(), [4000, 0, 0]);
        state.applyTexCoordShifts(shiftUniforms, geometry, model);
        assert.ok(Math.abs((348660 - 4000) / 4 - applied.l1[0]) <= 1, 'check shift with model matrix');
    });
}
