import { assert } from 'chai';
import P from 'bluebird';
import mockup from 'tests/mockup/mockup';
import WebGLCaps from 'osg/WebGLCaps';
import LightPoint from 'osg/LightPoint';
import LightPointNode from 'osg/LightPointNode';
import NodeVisitor from 'osg/NodeVisitor';
import Node from 'osg/Node';
import State from 'osg/State';
import Geometry from 'osg/Geometry';
import ShaderGeneratorProxy from 'osgShader/ShaderGeneratorProxy';
import { mat4 } from 'osg/glMatrix';
import Input from 'osgDB/Input';
import lightPointUtils from 'osg/lightPointUtils';
import vertexShader from 'osg/shaders/lightPoint.vert';
import fragmentShader from 'osg/shaders/lightPoint.frag';

export default function() {
    test('LightPoint defaults and validation', function() {
        var point = new LightPoint();
        assert.deepEqual(point.getPosition(), [0, 0, 0]);
        assert.deepEqual(point.getColor(), [1, 1, 1, 1]);
        assert.equal(point.getRadius(), 1);
        assert.equal(point.getIntensity(), 1);
        assert.equal(point.getBlendingMode(), LightPoint.BLENDED);
        assert.isTrue(point.getOn());
        assert.throws(function() {
            point.setRadius(-1);
        }, RangeError);
        assert.throws(function() {
            point.setPosition([1, 2, NaN]);
        }, RangeError);
        assert.throws(function() {
            point.setBlendingMode(5);
        }, RangeError);
    });

    test('LightPoint intensity controls sprite area, not color', function() {
        var node = new LightPointNode();
        var point = new LightPoint([0, 0, 0], [1, 0.5, 0.25, 0.8]);
        var color = [];
        point.setIntensity(0.25);
        node.evaluateLightPoint(point, [0, 0, 1], color);
        assert.deepEqual(color, [1, 0.5, 0.25, 0.8]);
        assert.equal(node.getLightPointIntensity(point, [0, 0, 1]), 0.25);
        point.setIntensity(2);
        node.evaluateLightPoint(point, [0, 0, 1], color);
        assert.deepEqual(color, [1, 0.5, 0.25, 0.8]);
        assert.equal(node.getLightPointIntensity(point, [0, 0, 1]), 2);
        point.setIntensity(-1);
        node.evaluateLightPoint(point, [0, 0, 1], color);
        assert.equal(color[3], 0);
    });

    test('LightPoint sectors have smooth angular falloff', function() {
        var factor = lightPointUtils.sectorFactor;
        var cone = lightPointUtils.sector({
            Type: 'ConeSector',
            Axis: [0, 0, 1],
            Angle: Math.PI / 6,
            FadeAngle: Math.PI / 6
        });
        assert.equal(factor(cone, [0, 0, 1]), 1);
        assert.equal(factor(cone, [0, 0, -1]), 0);
        var fade = factor(cone, [Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)]);
        assert.isAbove(fade, 0);
        assert.isBelow(fade, 1);
        var azimuth = lightPointUtils.sector({
            Type: 'AzimSector',
            MinAzimuth: -0.5,
            MaxAzimuth: 0.5,
            AzimuthFadeAngle: 0.3
        });
        assert.equal(factor(azimuth, [0, 1, 0]), 1);
        assert.equal(factor(azimuth, [0, -1, 0]), 0);
        var elevation = lightPointUtils.sector({
            Type: 'ElevationSector',
            MinElevation: -0.2,
            MaxElevation: 0.2,
            ElevationFadeAngle: 0.4
        });
        assert.equal(factor(elevation, [1, 0, 0]), 1);
        assert.equal(factor(elevation, [0, 0, 1]), 0);
        var combined = lightPointUtils.sector(
            Object.assign({}, azimuth, elevation, { Type: 'AzimElevationSector' })
        );
        var v = [0.6, 1, 0.5];
        assert.closeTo(
            factor(combined, v),
            Math.min(factor(azimuth, v), factor(elevation, v)),
            1e-12
        );
        var directional = lightPointUtils.sector({
            Type: 'DirectionalSector',
            Direction: [0, 1, 0],
            HorizLobeAngle: 0.5,
            VertLobeAngle: 0.5,
            FadeAngle: 0.1
        });
        assert.equal(factor(directional, [0, 1, 0]), 1);
        assert.equal(factor(directional, [1, 0, 0]), 0);
        assert.throws(function() {
            lightPointUtils.sector({ Type: 'Unknown' });
        }, RangeError);
    });

    test('LightPoint blinking handles phase, groups, boundaries and long frames', function() {
        var sequence = lightPointUtils.blinkSequence({
            PhaseShift: 0.25,
            SequenceGroup: { BaseTime: 10 },
            Pulses: [{ Duration: 1, Color: [1, 0, 0, 1] }, { Duration: 1, Color: [0, 0, 1, 0] }]
        });
        var sample = lightPointUtils.pulseColor;
        assert.deepEqual(sample(sequence, 10.25, 0, []), [1, 0, 0, 1]);
        assert.deepEqual(
            sample(sequence, 11.25, 0, []),
            [1, 0, 0, 1],
            'boundary uses earlier pulse'
        );
        assert.deepEqual(sample(sequence, 11.75, 0, []), [0, 0, 1, 0]);
        assert.deepEqual(sample(sequence, 10.75, 1, []), [0.5, 0, 0.5, 0.5]);
        assert.deepEqual(sample(sequence, 10.75, 1000000, []), [0.5, 0, 0.5, 0.5]);
        sequence.PulsePeriod = 4;
        assert.deepEqual(
            sample(sequence, 12.25, 0, []),
            [0, 0, 1, 0],
            'exported pulse period is retained'
        );
        assert.deepEqual(sample(undefined, 0, 0, []), [1, 1, 1, 1]);
        var zero = lightPointUtils.blinkSequence({
            Pulses: [{ Duration: 0, Color: [1, 0, 0, 1] }, { Duration: 1, Color: [0, 1, 0, 1] }]
        });
        assert.deepEqual(sample(zero, 0, 0, []), [1, 0, 0, 1]);
        assert.deepEqual(sample(zero, 0, 0.25, []), [0, 1, 0, 1]);
    });

    test('LightPoint sectors match native rotated and combined golden values', function() {
        var directional = lightPointUtils.sector({
            Type: 'DirectionalSector',
            Direction: [1, 2, 3],
            HorizLobeAngle: 1.2,
            VertLobeAngle: 0.8,
            LobeRollAngle: 0.7,
            FadeAngle: 0.25
        });
        [
            [[0.2672612369, 0.5345224738, 0.8017837405], 1],
            [[0.7939310074, 0.4860957861, 0.3652182817], 0.6341547966],
            [[0.3793098927, 0.06800034642, 0.92276752], 0.6521092057],
            [[0.8415061831, 0.02550191619, 0.5396453142], 0.08959162235],
            [[0.9144250751, 0.3897336125, 0.1092445552], 0]
        ].forEach(function(sample) {
            assert.closeTo(lightPointUtils.sectorFactor(directional, sample[0]), sample[1], 1e-5);
        });
        var combined = lightPointUtils.sector({
            Type: 'AzimElevationSector',
            MinAzimuth: -1,
            MaxAzimuth: 1,
            MinElevation: -0.5,
            MaxElevation: 0.5,
            AzimuthFadeAngle: 0.1,
            ElevationFadeAngle: 0.1
        });
        [
            [[0.8674232364, 0.4975710511, 0], 0.5071721673],
            [[0.7394995689, 0.4241915345, 0.5226872563], 0.4923340678],
            [[-0.7394995689, 0.4241915345, -0.5226872563], 0.4923347831]
        ].forEach(function(sample) {
            assert.closeTo(lightPointUtils.sectorFactor(combined, sample[0]), sample[1], 1e-5);
        });
    });

    test('LightPoint systems scale intensity and control animation', function() {
        var node = new LightPointNode();
        var point = new LightPoint();
        point.setIntensity(100);
        point.setBlinkSequence({ Pulses: [{ Duration: 1, Color: [0, 0, 0, 0] }] });
        node.setLightPointSystem({ Intensity: 0.5, AnimationState: 'ANIMATION_OFF' });
        assert.equal(node.getLightPointIntensity(point, [0, 0, 1]), 50);
        node.getLightPointSystem().Intensity = 0;
        assert.equal(node.getLightPointIntensity(point, [0, 0, 1]), 0);
        node.getLightPointSystem().Intensity = 0.5;
        assert.deepEqual(node.evaluateLightPoint(point, [0, 0, 1], []), [1, 1, 1, 1]);
        node.getLightPointSystem().AnimationState = 'ANIMATION_ON';
        assert.equal(node.evaluateLightPoint(point, [0, 0, 1], [])[3], 0);
        node.getLightPointSystem().AnimationState = 'ANIMATION_RANDOM';
        assert.deepEqual(node.evaluateLightPoint(point, [0, 0, 1], []), [1, 1, 1, 1]);
    });

    test('LightPointNode batches, bounds and record edits', function() {
        WebGLCaps.instance(mockup.createCanvas(true).getContext());
        var node = new LightPointNode();
        var point = new LightPoint([10, 0, 0], [1, 0.3, 0.1, 1]);
        point.setRadius(2);
        assert.equal(node.addLightPoint(point), 0);
        var additive = new LightPoint([-10, 0, 0]);
        additive.setBlendingMode(LightPoint.ADDITIVE);
        node.addLightPoint(additive);
        assert.isTrue(node.getBound().valid());
        assert.isAtLeast(node.getBound().radius(), 12);
        assert.equal(node._batches.length, 2);
        assert.equal(node._batches[0].getPrimitiveSetList()[0].getCount(), 6);
        assert.deepEqual(Array.from(node.getBoundingBox().getMax()), [13, 3, 3]);
        point.setPosition([30, 0, 0]);
        node.dirtyLightPoints();
        assert.equal(node.getBoundingBox().getMax()[0], 33);
        point.setOn(false);
        var color = node.evaluateLightPoint(point, [0, 0, 1], []);
        assert.equal(color[3], 0);
        node.removeLightPoint(1);
        assert.equal(node.getNumLightPoints(), 1);
        assert.throws(function() {
            node.getLightPoint(3);
        }, RangeError);
        assert.throws(function() {
            node.setMinPixelSize(40);
        }, RangeError);
        node.setLightPointList([]);
        assert.isFalse(node.getBound().valid());
    });

    test('LightPointNode draws before transparent geometry, then marks cores in depth', function() {
        WebGLCaps.instance(mockup.createCanvas(true).getContext());
        var node = new LightPointNode();
        node.addLightPoint(new LightPoint([0, 0, 0]));
        node.getBound();
        var color = node._batches[0];
        var depth = color._lightPointDepthPass;
        var colorState = color.getStateSet();
        var depthState = depth.getStateSet();
        // Opaque bin 0 and SWEA's bin 9 come first; the transparent bin 10 follows.
        assert.isAbove(colorState.getBinNumber(), 9);
        assert.isAbove(depthState.getBinNumber(), colorState.getBinNumber());
        assert.isBelow(depthState.getBinNumber(), 10);
        assert.isFalse(colorState.getAttribute('Depth').getWriteMask());
        assert.isTrue(depthState.getAttribute('Depth').getWriteMask());
        assert.deepEqual(
            [
                depthState.getAttribute('ColorMask')._red,
                depthState.getAttribute('ColorMask')._green,
                depthState.getAttribute('ColorMask')._blue,
                depthState.getAttribute('ColorMask')._alpha
            ],
            [false, false, false, false]
        );
        assert.equal(depthState.getUniform('uLightPointDepthPass').getInternalArray()[0], 1);
        assert.equal(colorState.getUniform('uLightPointDepthPass').getInternalArray()[0], 0);
        assert.strictEqual(
            depth.getVertexAttributeList().Color,
            color.getVertexAttributeList().Color
        );
        assert.strictEqual(depth.getPrimitiveSetList()[0], color.getPrimitiveSetList()[0]);
        var visited = [];
        var visitor = new NodeVisitor();
        visitor.apply = function(child) {
            visited.push(child);
        };
        visitor.visitorType = NodeVisitor.CULL_VISITOR;
        node.traverse(visitor);
        assert.deepEqual(visited, [color, depth]);
    });

    test('LightPointNode hides its dynamic batches from non-cull visitors', function() {
        WebGLCaps.instance(mockup.createCanvas(true).getContext());
        var node = new LightPointNode();
        var point = new LightPoint([0, 0, 0]);
        point.setSector({
            Type: 'DirectionalSector',
            Direction: [0, 1, 0],
            HorizLobeAngle: Math.PI,
            VertLobeAngle: Math.PI
        });
        node.addLightPoint(point);
        var child = new Node();
        node.addChild(child);
        var visited = [];
        // Like an application visitor that frees uploaded vertex colors.
        var visitor = new NodeVisitor(NodeVisitor.TRAVERSE_ALL_CHILDREN);
        visitor.apply = function(visitedNode) {
            visited.push(visitedNode);
            if (visitedNode instanceof Geometry)
                visitedNode.getVertexAttributeList().Color.compile = function() {};
        };
        node.traverse(visitor);
        assert.deepEqual(visited, [child], 'regular children are still traversed');
        var parent = new Node();
        parent.addChild(node);
        assert.deepEqual(Array.from(parent.getBoundingBox().getMax()), [2, 2, 2]);
        var batch = node._batches[0];
        assert.isFalse(
            Object.prototype.hasOwnProperty.call(batch.getVertexAttributeList().Color, 'compile')
        );
        // Behind the 180-degree lobe the light is off, in front it is on.
        assert.equal(node.evaluateLightPoint(point, [0, -1, 0], [])[3], 0);
        assert.equal(node.evaluateLightPoint(point, [0, 1, 0], [])[3], 1);
    });

    test('LightPoint shaders share no uniforms, avoiding precision link errors', function() {
        var uniforms = function(source) {
            var names = [];
            source.replace(/uniform\s+(?:\w+\s+)?\w+\s+(\w+)\s*;/g, function(match, name) {
                names.push(name);
            });
            return names;
        };
        var vertexUniforms = uniforms(vertexShader);
        assert.include(vertexUniforms, 'uLightPointGlow');
        assert.include(vertexUniforms, 'uLightPointStar');
        // Vertex uniforms default to highp, fragment ones are mediump here.
        uniforms(fragmentShader).forEach(function(name) {
            assert.notInclude(vertexUniforms, name);
        });
    });

    test('LightPointNode glow is global and shared by both passes', function() {
        WebGLCaps.instance(mockup.createCanvas(true).getContext());
        var original = LightPointNode.getGlow();
        assert.isAtLeast(original[0], 1);
        assert.isAbove(original[1], 0);
        assert.throws(function() {
            LightPointNode.setGlow(0.5, 0.5);
        }, RangeError);
        assert.throws(function() {
            LightPointNode.setGlow(2, -1);
        }, RangeError);
        var node = new LightPointNode();
        node.addLightPoint(new LightPoint([0, 0, 0]));
        node.getBound();
        var color = node._batches[0];
        var uniform = color.getStateSet().getUniform('uLightPointGlow');
        assert.strictEqual(
            color._lightPointDepthPass.getStateSet().getUniform('uLightPointGlow'),
            uniform
        );
        LightPointNode.setGlow(4, 0);
        assert.deepEqual(LightPointNode.getGlow(), [4, 0]);
        LightPointNode.setGlow(original[0], original[1]);
        assert.deepEqual(LightPointNode.getGlow(), original);
    });

    test('LightPointNode star is global and only for blinking lights', function() {
        WebGLCaps.instance(mockup.createCanvas(true).getContext());
        var original = LightPointNode.getStar();
        assert.isAbove(original, 0);
        assert.throws(function() {
            LightPointNode.setStar(-1);
        }, RangeError);
        LightPointNode.setStar(0);
        assert.equal(LightPointNode.getStar(), 0);
        LightPointNode.setStar(original);
        var node = new LightPointNode();
        var point = new LightPoint();
        node.addLightPoint(point);
        node.getBound();
        var color = node._batches[0];
        assert.strictEqual(
            color._lightPointDepthPass.getStateSet().getUniform('uLightPointStar'),
            color.getStateSet().getUniform('uLightPointStar')
        );
        assert.isFalse(node.isLightPointAnimated(point));
        point.setBlinkSequence({ Pulses: [] });
        assert.isFalse(node.isLightPointAnimated(point), 'no pulses, no blinking');
        point.setBlinkSequence({ Pulses: [{ Duration: 1, Color: [1, 1, 1, 1] }] });
        assert.isTrue(node.isLightPointAnimated(point));
        node.setLightPointSystem({ AnimationState: 'ANIMATION_OFF' });
        assert.isFalse(node.isLightPointAnimated(point), 'system animation off');
    });

    test('LightPointNode supports WebGL 1 index limits', function() {
        var node = new LightPointNode();
        var points = [];
        for (var i = 0; i < 16384; i++) points.push(new LightPoint([i, 0, 0]));
        node.setLightPointList(points);
        node.traverse(new NodeVisitor());
        assert.equal(node._batches.length, 2);
        node._batches.forEach(function(batch) {
            var indices = batch
                .getPrimitiveSetList()[0]
                .getIndices()
                .getElements();
            assert.instanceOf(indices, Uint16Array);
            for (var j = 0; j < indices.length; j++) assert.isBelow(indices[j], 65535);
        });
    });

    test('LightPoint draw inputs use current model-view and viewport', function() {
        var state = new State(new ShaderGeneratorProxy());
        state.viewport(20, 10, 320, 180);
        assert.deepEqual(state.getViewportSize([]), [320, 180]);
        var matrix = mat4.fromTranslation(mat4.create(), [10, 20, 30]);
        state._modelViewMatrix.setMatrix4(matrix);
        assert.deepEqual(Array.from(state.getModelViewMatrix()), Array.from(matrix));
    });

    test('LightPoint batches sort and evaluate separately for each draw', function() {
        var node = new LightPointNode();
        var a = new LightPoint([0, 0, -2], [1, 0, 0, 1]);
        var b = new LightPoint([0, 0, -8], [0, 1, 0, 1]);
        b.setIntensity(20);
        b.setBlinkSequence({ Pulses: [{ Duration: 1, Color: [1, 1, 1, 1] }] });
        node.setLightPointList([a, b]);
        node.getBound();
        var batch = node._batches[0];
        var matrix = mat4.create();
        var sent = {};
        var uploads = 0;
        var gl = {
            createBuffer: function() {
                return {};
            },
            bindBuffer: function() {},
            bufferData: function() {
                uploads++;
            },
            uniform2fv: function(name, value) {
                sent[name] = Array.from(value);
            },
            uniform1fv: function(name, value) {
                sent[name] = Array.from(value);
            }
        };
        var state = {
            getModelViewMatrix: function() {
                return matrix;
            },
            getViewportSize: function(out) {
                out[0] = 320;
                out[1] = 180;
            },
            getGraphicContext: function() {
                return gl;
            },
            getLastProgramApplied: function() {
                return {
                    getUniformsCache: function() {
                        return {
                            uLightPointViewport: 'viewport',
                            uLightPointPixelSize: 'size',
                            uLightPointMaxDistance: 'distance'
                        };
                    }
                };
            }
        };
        var draw = Geometry.prototype.drawImplementation;
        Geometry.prototype.drawImplementation = function() {};
        try {
            batch.drawImplementation(state);
            assert.deepEqual(sent.viewport, [320, 180]);
            assert.deepEqual(sent.size, [0, 30]);
            assert.deepEqual(
                Array.from(batch.getVertexAttributeList().Intensity.getElements()),
                [1, 1, 1, 1, 20, 20, 20, 20],
                'intensity per vertex drives the glow'
            );
            assert.deepEqual(
                Array.from(batch.getVertexAttributeList().Animated.getElements()),
                [0, 0, 0, 0, 1, 1, 1, 1],
                'only blinking lights get a star'
            );
            var indices = batch
                .getPrimitiveSetList()[0]
                .getIndices()
                .getElements();
            assert.equal(indices[0], 4, 'far point first');
            mat4.fromYRotation(matrix, Math.PI);
            a.setOn(false);
            batch.drawImplementation(state);
            assert.equal(indices[0], 0, 'order changes for another camera');
            assert.equal(
                batch.getVertexAttributeList().Color.getElements()[3],
                0,
                'off point invisible'
            );
            assert.equal(uploads, 8, 'dynamic attributes upload even with an unchanged VAO');
        } finally {
            Geometry.prototype.drawImplementation = draw;
        }
    });

    test('LightPoint .osgjs records and nodes', function() {
        var input = new Input();
        return input
            .setJSON({
                'osg.LightPointNode': {
                    Name: 'runway',
                    MinPixelSize: 1,
                    MaxPixelSize: 48,
                    MaxVisibleDistance2: 10000,
                    PointSprite: true,
                    LightPoints: [
                        {
                            Position: [1, 2, 3],
                            Color: [1, 0, 0, 0.5],
                            Intensity: 2,
                            Radius: 0.1,
                            BlendingMode: 'ADDITIVE'
                        },
                        { On: false }
                    ]
                }
            })
            .readObject()
            .then(function(node) {
                assert.instanceOf(node, LightPointNode);
                assert.equal(node.getName(), 'runway');
                assert.equal(node.getNumLightPoints(), 2);
                assert.equal(node.getMinPixelSize(), 1);
                assert.equal(node.getMaxPixelSize(), 48);
                assert.equal(node.getMaxVisibleDistance2(), 10000);
                assert.isTrue(node.getPointSprite());
                assert.deepEqual(node.getLightPoint(0).getPosition(), [1, 2, 3]);
                assert.equal(node.getLightPoint(0).getBlendingMode(), LightPoint.ADDITIVE);
                assert.equal(node.getLightPoint(0).getIntensity(), 2);
                assert.isFalse(node.getLightPoint(1).getOn());
                return input.setJSON({ 'osg.LightPoint': { Position: [4, 5, 6] } }).readObject();
            })
            .then(function(point) {
                assert.instanceOf(point, LightPoint);
                assert.deepEqual(point.getPosition(), [4, 5, 6]);
            });
    });

    test('LightPoint .osgjs rejects malformed data', function() {
        var invalid = [
            { LightPoints: 'bad' },
            { LightPoints: [null] },
            { LightPoints: [{ Radius: -1 }] },
            { LightPoints: [{ Position: [1, 2] }] },
            { LightPoints: [{ BlendingMode: 'invalid' }] },
            { LightPoints: [{ Sector: { Type: 'Unknown' } }] },
            { LightPoints: [{ BlinkSequence: { UniqueID: 999 } }] },
            {
                LightPoints: [
                    { BlinkSequence: { Pulses: [{ Duration: -1, Color: [1, 1, 1, 1] }] } }
                ]
            },
            { LightPointSystem: { AnimationState: 'INVALID' } },
            { MinPixelSize: 40, MaxPixelSize: 20 },
            { MaxVisibleDistance2: -1 }
        ];
        return P.all(
            invalid.map(function(json) {
                return new Input()
                    .setJSON({ 'osg.LightPointNode': json })
                    .readObject()
                    .then(
                        function() {
                            assert.fail('Invalid light-point data was accepted');
                        },
                        function(error) {
                            assert.instanceOf(error, Error);
                        }
                    );
            })
        );
    });

    test('LightPoint .osgjs shares systems, sequences and sequence groups', function() {
        return new Input()
            .setJSON({
                'osg.Node': {
                    Children: [
                        {
                            'osg.LightPointNode': {
                                LightPointSystem: {
                                    UniqueID: 10,
                                    Intensity: 3,
                                    AnimationState: 'ANIMATION_ON'
                                },
                                LightPoints: [
                                    {
                                        BlinkSequence: {
                                            UniqueID: 20,
                                            PulsePeriod: 2,
                                            PhaseShift: 0.1,
                                            Pulses: [{ Duration: 2, Color: [1, 0, 0, 1] }],
                                            SequenceGroup: { UniqueID: 30, BaseTime: 123 }
                                        }
                                    },
                                    {
                                        BlinkSequence: {
                                            UniqueID: 21,
                                            Pulses: [],
                                            SequenceGroup: { UniqueID: 30 }
                                        }
                                    }
                                ]
                            }
                        },
                        {
                            'osg.LightPointNode': {
                                LightPointSystem: { UniqueID: 10 },
                                LightPoints: [{ BlinkSequence: { UniqueID: 20 } }]
                            }
                        }
                    ]
                }
            })
            .readObject()
            .then(function(root) {
                var a = root.getChildren()[0];
                var b = root.getChildren()[1];
                assert.strictEqual(a.getLightPointSystem(), b.getLightPointSystem());
                assert.strictEqual(
                    a.getLightPoint(0).getBlinkSequence(),
                    b.getLightPoint(0).getBlinkSequence()
                );
                assert.strictEqual(
                    a.getLightPoint(0).getBlinkSequence().SequenceGroup,
                    a.getLightPoint(1).getBlinkSequence().SequenceGroup
                );
                assert.equal(b.getLightPoint(0).getBlinkSequence().SequenceGroup.BaseTime, 123);
                a.getLightPointSystem().Intensity = 4;
                assert.equal(b.getLightPointIntensity(b.getLightPoint(0), [0, 0, 1]), 4);
            });
    });
}
