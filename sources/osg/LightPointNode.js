import utils from 'osg/utils';
import Node from 'osg/Node';
import NodeVisitor from 'osg/NodeVisitor';
import LightPoint from 'osg/LightPoint';
import lightPointUtils from 'osg/lightPointUtils';
import Geometry from 'osg/Geometry';
import BoundingBox from 'osg/BoundingBox';
import BufferArray from 'osg/BufferArray';
import DrawElements from 'osg/DrawElements';
import BlendFunc from 'osg/BlendFunc';
import ColorMask from 'osg/ColorMask';
import CullFace from 'osg/CullFace';
import Depth from 'osg/Depth';
import Program from 'osg/Program';
import Shader from 'osg/Shader';
import StateAttribute from 'osg/StateAttribute';
import Uniform from 'osg/Uniform';
import { mat4, vec3 } from 'osg/glMatrix';
import vertexShader from 'osg/shaders/lightPoint.vert';
import fragmentShader from 'osg/shaders/lightPoint.frag';

var corners = [-1, -1, 1, -1, 1, 1, -1, 1];
var triangles = [0, 1, 2, 0, 2, 3];
// Stay below the WebGL 1 unsigned-short index limit, without extensions.
var batchSize = 16383;
// Lights draw after opaque geometry (and SWEA's bin 9) but before the
// transparent bin 10: semi-transparent surfaces in front, such as rotor blur
// disks or glass, then dim lights instead of hiding them through their depth.
// A later depth-only pass marks the bright cores so transparent surfaces
// behind a light cannot paint over it.
var colorBin = 9.5;
var depthBin = 9.75;

var nonnegative = function(value, name) {
    if (!Number.isFinite(value) || value < 0)
        throw new RangeError('Invalid LightPointNode ' + name);
    return value;
};

var createBatch = function(owner, points, additive) {
    var geometry = new Geometry();
    var count = points.length;
    var vertices = new Float32Array(count * 12);
    var cornerArray = new Float32Array(count * 8);
    var radii = new Float32Array(count * 4);
    var colors = new Float32Array(count * 16);
    var indices = new Uint16Array(count * 6);
    var order = [];
    var box = new BoundingBox();
    points.forEach(function(point, index) {
        order.push({ index: index, depth: 0 });
        for (var v = 0; v < 4; v++) {
            vertices.set(point._position, index * 12 + v * 3);
            radii[index * 4 + v] = point._radius;
        }
        cornerArray.set(corners, index * 8);
        for (var k = 0; k < 6; k++) indices[index * 6 + k] = index * 4 + triangles[k];
        var p = point._position;
        var r = point._radius + 1;
        box.expandByVec3([p[0] - r, p[1] - r, p[2] - r]);
        box.expandByVec3([p[0] + r, p[1] + r, p[2] + r]);
    });
    geometry.setBound(box);
    var attributes = geometry.getVertexAttributeList();
    attributes.Vertex = new BufferArray(BufferArray.ARRAY_BUFFER, vertices, 3);
    attributes.Corner = new BufferArray(BufferArray.ARRAY_BUFFER, cornerArray, 2);
    attributes.Radius = new BufferArray(BufferArray.ARRAY_BUFFER, radii, 1);
    attributes.Radius.setUsage(BufferArray.DYNAMIC_DRAW);
    attributes.Color = new BufferArray(BufferArray.ARRAY_BUFFER, colors, 4);
    attributes.Color.setUsage(BufferArray.DYNAMIC_DRAW);
    var indexBuffer = new BufferArray(BufferArray.ELEMENT_ARRAY_BUFFER, indices, 1);
    if (!additive) indexBuffer.setUsage(BufferArray.DYNAMIC_DRAW);
    geometry.getPrimitiveSetList().push(new DrawElements('TRIANGLES', indexBuffer));

    if (!owner._program)
        owner._program = new Program(
            new Shader('VERTEX_SHADER', vertexShader),
            new Shader('FRAGMENT_SHADER', fragmentShader)
        );
    var stateset = geometry.getOrCreateStateSet();
    var mode = StateAttribute.ON | StateAttribute.PROTECTED;
    stateset.setAttributeAndModes(owner._program, mode);
    stateset.setAttributeAndModes(new Depth(Depth.LEQUAL, 0, 1, false), mode);
    stateset.setAttributeAndModes(new CullFace(CullFace.DISABLE), mode);
    stateset.setAttributeAndModes(
        new BlendFunc(BlendFunc.ONE, additive ? BlendFunc.ONE : BlendFunc.ONE_MINUS_SRC_ALPHA),
        mode
    );
    stateset.setRenderBinDetails(colorBin, 'DepthSortedBin');
    var viewport = Uniform.createFloat2([1, 1], 'uLightPointViewport');
    var pixelSize = Uniform.createFloat2([0, 30], 'uLightPointPixelSize');
    var maxDistance = Uniform.createFloat1(1, 'uLightPointMaxDistance');
    stateset.addUniform(viewport);
    stateset.addUniform(pixelSize);
    stateset.addUniform(maxDistance);
    stateset.addUniform(Uniform.createFloat1(0, 'uLightPointDepthPass'));

    var depthGeometry = new Geometry();
    depthGeometry.setBound(box);
    var depthAttributes = depthGeometry.getVertexAttributeList();
    Object.keys(attributes).forEach(function(name) {
        depthAttributes[name] = attributes[name];
    });
    depthGeometry.getPrimitiveSetList().push(geometry.getPrimitiveSetList()[0]);
    var depthStateset = depthGeometry.getOrCreateStateSet();
    depthStateset.setAttributeAndModes(owner._program, mode);
    depthStateset.setAttributeAndModes(new Depth(Depth.LEQUAL, 0, 1, true), mode);
    depthStateset.setAttributeAndModes(new CullFace(CullFace.DISABLE), mode);
    depthStateset.setAttributeAndModes(new ColorMask(false, false, false, false), mode);
    depthStateset.setRenderBinDetails(depthBin, 'RenderBin');
    depthStateset.addUniform(viewport);
    depthStateset.addUniform(pixelSize);
    depthStateset.addUniform(maxDistance);
    depthStateset.addUniform(Uniform.createFloat1(1, 'uLightPointDepthPass'));
    geometry._lightPointDepthPass = depthGeometry;
    var inverse = mat4.create();
    var eye = vec3.create();
    var direction = vec3.create();
    var color = [0, 0, 0, 0];
    var viewportSize = [1, 1];

    var drawWithDynamicData = function(target, state) {
        var gl = state.getGraphicContext();
        var uniforms = state.getLastProgramApplied().getUniformsCache();
        viewport.apply(gl, uniforms.uLightPointViewport);
        pixelSize.apply(gl, uniforms.uLightPointPixelSize);
        maxDistance.apply(gl, uniforms.uLightPointMaxDistance);
        // A cached VAO may stay bound between draws; Geometry only refreshes
        // its attribute buffers when the VAO changes.
        attributes.Color.bind(gl);
        attributes.Color.compile(gl);
        attributes.Radius.bind(gl);
        attributes.Radius.compile(gl);
        Geometry.prototype.drawImplementation.call(target, state);
    };

    // View-dependent work belongs at draw time: a node can be shared by
    // multiple transforms, cameras and viewports in the same frame.
    geometry.drawImplementation = function(state) {
        var matrix = state.getModelViewMatrix();
        if (!mat4.invert(inverse, matrix))
            throw new Error('Cannot render LightPointNode with a singular model-view matrix');
        vec3.set(eye, inverse[12], inverse[13], inverse[14]);
        for (var i = 0; i < count; i++) {
            var point = points[i];
            vec3.sub(direction, eye, point._position);
            var intensity = owner.getLightPointIntensity(point, direction);
            owner.evaluateLightPoint(point, direction, color, intensity);
            for (var j = 0; j < 4; j++) {
                colors.set(color, i * 16 + j * 4);
                radii[i * 4 + j] = point._radius * Math.sqrt(intensity);
            }
            if (!additive) {
                var p = points[order[i].index]._position;
                order[i].depth = matrix[2] * p[0] + matrix[6] * p[1] + matrix[10] * p[2];
            }
        }
        attributes.Color.dirty();
        attributes.Radius.dirty();
        if (!additive) {
            order.sort(function(a, b) {
                return a.depth - b.depth;
            });
            for (var n = 0; n < count; n++)
                for (var t = 0; t < 6; t++) indices[n * 6 + t] = order[n].index * 4 + triangles[t];
            indexBuffer.dirty();
        }
        state.getViewportSize(viewportSize);
        viewport.setFloat2(viewportSize);
        pixelSize.setFloat2([owner._minPixelSize, owner._maxPixelSize]);
        maxDistance.setFloat(Math.sqrt(owner._maxVisibleDistance2));
        drawWithDynamicData(this, state);
    };
    // Runs later in the same render stage, reusing this frame's colors,
    // radii and sort order from the color pass.
    depthGeometry.drawImplementation = function(state) {
        drawWithDynamicData(this, state);
    };
    return geometry;
};

/**
 * Batched, emissive light points with a smooth falloff and faint glow. They are
 * occluded by opaque geometry, dimmed by transparent geometry in front of them,
 * and do not illuminate other objects.
 */
var LightPointNode = function() {
    Node.call(this);
    this._lightPointList = [];
    this._batches = [];
    this._dirtyLightPoints = true;
    this._minPixelSize = 0;
    this._maxPixelSize = 30;
    this._maxVisibleDistance2 = 3.4028234663852886e38;
    this._pointSprite = false;
    this._lightPointSystem = undefined;
    this._simulationTime = 0;
    this._simulationInterval = 0;
    this._lastSimulationTime = undefined;
    this._blinkColor = [1, 1, 1, 1];
    // Screen-space minimum sizes can extend beyond the world-space bounds.
    this.setCullingActive(false);
};

utils.createPrototypeNode(
    LightPointNode,
    utils.objectInherit(Node.prototype, {
        addLightPoint: function(point) {
            if (!(point instanceof LightPoint)) throw new TypeError('Expected an osg.LightPoint');
            this._lightPointList.push(point);
            this.dirtyLightPoints();
            return this._lightPointList.length - 1;
        },
        removeLightPoint: function(index) {
            if (!Number.isInteger(index) || index < 0 || index >= this._lightPointList.length)
                throw new RangeError('LightPoint index out of range');
            this._lightPointList.splice(index, 1);
            this.dirtyLightPoints();
        },
        getNumLightPoints: function() {
            return this._lightPointList.length;
        },
        getLightPoint: function(index) {
            if (!Number.isInteger(index) || index < 0 || index >= this._lightPointList.length)
                throw new RangeError('LightPoint index out of range');
            return this._lightPointList[index];
        },
        getLightPointList: function() {
            return this._lightPointList;
        },
        setLightPointList: function(points) {
            if (
                !Array.isArray(points) ||
                points.some(function(p) {
                    return !(p instanceof LightPoint);
                })
            )
                throw new TypeError('Expected an array of osg.LightPoint records');
            this._lightPointList = points.slice();
            this.dirtyLightPoints();
        },
        dirtyLightPoints: function() {
            this.dirtyBound();
        },
        dirtyBound: function() {
            this._dirtyLightPoints = true;
            Node.prototype.dirtyBound.call(this);
        },
        setMinPixelSize: function(size) {
            nonnegative(size, 'minimum pixel size');
            if (size > this._maxPixelSize)
                throw new RangeError('Minimum pixel size exceeds maximum');
            this._minPixelSize = size;
        },
        getMinPixelSize: function() {
            return this._minPixelSize;
        },
        setMaxPixelSize: function(size) {
            nonnegative(size, 'maximum pixel size');
            if (size < this._minPixelSize)
                throw new RangeError('Maximum pixel size is below minimum');
            this._maxPixelSize = size;
        },
        getMaxPixelSize: function() {
            return this._maxPixelSize;
        },
        setMaxVisibleDistance2: function(distance) {
            this._maxVisibleDistance2 = nonnegative(distance, 'squared visible distance');
        },
        getMaxVisibleDistance2: function() {
            return this._maxVisibleDistance2;
        },
        setPointSprite: function(enabled) {
            if (typeof enabled !== 'boolean') throw new TypeError('Invalid PointSprite flag');
            this._pointSprite = enabled;
        },
        getPointSprite: function() {
            return this._pointSprite;
        },
        setLightPointSystem: function(system) {
            this._lightPointSystem =
                system === undefined || system === null
                    ? undefined
                    : lightPointUtils.system(system);
        },
        getLightPointSystem: function() {
            return this._lightPointSystem;
        },
        getLightPointIntensity: function(point, direction) {
            if (!point._on) return 0;
            var intensity = this._lightPointSystem
                ? this._lightPointSystem.Intensity
                : point._intensity;
            return Math.max(0, intensity) * lightPointUtils.sectorFactor(point._sector, direction);
        },
        evaluateLightPoint: function(point, direction, result, intensity) {
            if (intensity === undefined) intensity = this.getLightPointIntensity(point, direction);
            var sequence =
                !this._lightPointSystem || this._lightPointSystem.AnimationState === 'ANIMATION_ON'
                    ? point._blinkSequence
                    : undefined;
            var blink = lightPointUtils.pulseColor(
                sequence,
                this._simulationTime,
                this._simulationInterval,
                this._blinkColor
            );
            for (var i = 0; i < 3; i++) result[i] = point._color[i] * blink[i];
            result[3] = intensity > 0 ? Math.max(0, Math.min(1, point._color[3] * blink[3])) : 0;
            return result;
        },
        _rebuild: function() {
            if (!this._dirtyLightPoints) return;
            for (var b = 0; b < this._batches.length; b++) {
                this._batches[b].releaseGLObjects();
                this._batches[b]._lightPointDepthPass.releaseGLObjects();
            }
            this._batches = [];
            for (var mode = 0; mode < 2; mode++) {
                var points = this._lightPointList.filter(function(point) {
                    return point._blendingMode === mode;
                });
                for (var start = 0; start < points.length; start += batchSize) {
                    this._batches.push(
                        createBatch(
                            this,
                            points.slice(start, start + batchSize),
                            mode === LightPoint.ADDITIVE
                        )
                    );
                }
            }
            this._dirtyLightPoints = false;
        },
        traverse: function(visitor) {
            this._rebuild();
            if (visitor.getVisitorType() === NodeVisitor.CULL_VISITOR && visitor.getFrameStamp()) {
                var time = visitor.getFrameStamp().getSimulationTime();
                if (time !== this._lastSimulationTime) {
                    this._simulationInterval =
                        this._lastSimulationTime === undefined
                            ? 0
                            : Math.max(0, time - this._lastSimulationTime);
                    this._lastSimulationTime = this._simulationTime = time;
                }
            }
            for (var i = 0; i < this._batches.length; i++) {
                this._batches[i].accept(visitor);
                this._batches[i]._lightPointDepthPass.accept(visitor);
            }
            Node.prototype.traverse.call(this, visitor);
        },
        computeBoundingBox: function(box) {
            this._rebuild();
            return Node.prototype.computeBoundingBox.call(this, box);
        },
        computeBoundingSphere: function(sphere) {
            this._rebuild();
            sphere.init();
            for (var i = 0; i < this._batches.length; i++)
                sphere.expandByBoundingSphere(this._batches[i].getBound());
            for (var j = 0; j < this.children.length; j++)
                sphere.expandByBoundingSphere(this.children[j].getBound());
            return sphere;
        },
        releaseGLObjects: function() {
            if (this.stateset !== undefined) this.stateset.releaseGLObjects();
            for (var i = 0; i < this._batches.length; i++) {
                this._batches[i].releaseGLObjects();
                this._batches[i]._lightPointDepthPass.releaseGLObjects();
            }
        }
    }),
    'osg',
    'LightPointNode'
);

export default LightPointNode;
