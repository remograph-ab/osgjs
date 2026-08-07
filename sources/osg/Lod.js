import utils from 'osg/utils';
import Node from 'osg/Node';
import NodeVisitor from 'osg/NodeVisitor';
import { mat4 } from 'osg/glMatrix';
import { vec2 } from 'osg/glMatrix';
import { vec3 } from 'osg/glMatrix';
import { vec4 } from 'osg/glMatrix';
import BoundingSphere from 'osg/BoundingSphere';

/**
 *  Lod that can contains child node
 *  @class Lod
 */
var Lod = function() {
    Node.call(this);
    this._radius = -1;
    this._range = [];
    this._rangeMode = Lod.DISTANCE_FROM_EYE_POINT;
    this._userDefinedCenter = [];
    this._centerMode = Lod.USE_BOUNDING_SPHERE_CENTER;
    
    this._userDefinedRadius = -1;
    this._activeChildren = [];
};

Lod.DISTANCE_FROM_EYE_POINT = 0;
Lod.PIXEL_SIZE_ON_SCREEN = 1;

Lod.USE_BOUNDING_SPHERE_CENTER = 0;
Lod.USER_DEFINED_CENTER = 1;
Lod.UNION_OF_BOUNDING_SPHERE_AND_USER_DEFINED = 2;

/** @lends Lod.prototype */
utils.createPrototypeNode(
    Lod,
    utils.objectInherit(Node.prototype, {
        // Functions here
        getRadius: function() {
            return this._radius;
        },

        /** Set the object-space reference radius of the volume enclosed by the LOD.
         * Used to determine the bounding sphere of the LOD in the absence of any children.*/
        setRadius: function(radius) {
            this._radius = radius;
        },

        setUserDefinedRadius: function(userDefinedRadius) {
            this._userDefinedRadius = userDefinedRadius;
        },

        getActiveChildren: function() {
            return this._activeChildren;
        },

        setCenter: function(center) {
            if (this._centerMode !== Lod.UNION_OF_BOUNDING_SPHERE_AND_USER_DEFINED)
                this._centerMode = Lod.USER_DEFINED_CENTER;
            this._userDefinedCenter = center;
        },

        getCenter: function() {
            if (
                this._centerMode === Lod.USER_DEFINED_CENTER ||
                this._centerMode === Lod.UNION_OF_BOUNDING_SPHERE_AND_USER_DEFINED
            )
                return this._userDefinedCenter;
            else return this.getBound().center();
        },

        setCenterMode: function(centerMode) {
            this._centerMode = centerMode;
        },

        computeBoundingSphere: function(bsphere) {
            if (this._centerMode === Lod.USER_DEFINED_CENTER && this._radius >= 0.0) {
                bsphere.set(this._userDefinedCenter, this._radius);
                return bsphere;
            } else if (
                this._centerMode === Lod.UNION_OF_BOUNDING_SPHERE_AND_USER_DEFINED &&
                this._radius >= 0.0
            ) {
                bsphere.set(this._userDefinedCenter, this._radius);
                var bs = new BoundingSphere();
                bsphere.expandByBoundingSphere(Node.prototype.computeBoundingSphere.call(this, bs));
                return bsphere;
            } else {
                Node.prototype.computeBoundingSphere.call(this, bsphere);
                if (this._userDefinedRadius !== -1 && this._userDefinedCenter.length > 0) {
                  bsphere.set(vec3.clone(this._userDefinedCenter), bsphere.radius());
                }
                return bsphere;
            }
        },

        projectBoundingSphere: (function() {
            // from http://www.iquilezles.org/www/articles/sphereproj/sphereproj.htm
            // Sample code at http://www.shadertoy.com/view/XdBGzd?
            var o = vec3.create();
            return function(sph, camMatrix, fle) {
                vec3.transformMat4(o, sph.center(), camMatrix);
                var r2 = sph.radius2();
                var z2 = o[2] * o[2];
                var l2 = vec3.sqrLen(o);
                var area =
                    -Math.PI *
                    fle *
                    fle *
                    r2 *
                    Math.sqrt(Math.abs((l2 - r2) / (r2 - z2))) /
                    (r2 - z2);
                return area;
            };
        })(),

        setRangeMode: function(mode) {
            //TODO: check if mode is correct
            this._rangeMode = mode;
        },

        addChildNode: function(node) {
            Node.prototype.addChild.call(this, node);
            if (this.children.length > this._range.length) {
                var r = [];
                var max = 0.0;
                if (this._range.length > 0) max = this._range[this._range.length - 1][1];
                r.push(vec2.fromValues(max, max));
                this._range.push(r);
            }
            return true;
        },

        addChild: function(node, min, max) {
            Node.prototype.addChild.call(this, node);

            if (this.children.length > this._range.length) {
                var r = [];
                r.push(vec2.fromValues(min, min));
                this._range.push(r);
            }
            this._range[this.children.length - 1][0] = min;
            this._range[this.children.length - 1][1] = max;
            return true;
        },

        computePixelSizeVector: (function() {
            var scale00 = vec3.create();
            var scale10 = vec3.create();
            return function(W, P, M) {
                // Where W = viewport, P = ProjectionMatrix, M = ModelViewMatrix
                // Comment from OSG:
                // pre adjust P00,P20,P23,P33 by multiplying them by the viewport window matrix.
                // here we do it in short hand with the knowledge of how the window matrix is formed
                // note P23,P33 are multiplied by an implicit 1 which would come from the window matrix.

                // scaling for horizontal pixels
                var P00 = P[0] * W.width() * 0.5;
                var P20_00 = P[8] * W.width() * 0.5 + P[11] * W.width() * 0.5;
                vec3.set(
                    scale00,
                    M[0] * P00 + M[2] * P20_00,
                    M[4] * P00 + M[6] * P20_00,
                    M[8] * P00 + M[10] * P20_00
                );

                // scaling for vertical pixels
                var P10 = P[5] * W.height() * 0.5;
                var P20_10 = P[9] * W.height() * 0.5 + P[11] * W.height() * 0.5;
                vec3.set(
                    scale10,
                    M[1] * P10 + M[2] * P20_10,
                    M[5] * P10 + M[6] * P20_10,
                    M[9] * P10 + M[10] * P20_10
                );

                var P23 = P[11];
                var P33 = P[15];
                var pixelSizeVector = vec4.fromValues(
                    M[2] * P23,
                    M[6] * P23,
                    M[10] * P23,
                    M[14] * P23 + M[15] * P33
                );

                var scaleRatio =
                    0.7071067811 / Math.sqrt(vec3.sqrLen(scale00) + vec3.sqrLen(scale10));
                vec4.scale(pixelSizeVector, pixelSizeVector, scaleRatio);
                return pixelSizeVector;
            };
        })(),
        
        pixelSize: function(bound, viewport, projMatrix, viewMatrix) {
            const center3 = bound.center();
            const center4 = vec4.fromValues(center3[0], center3[1], center3[2], 1.0);
            const radius = (this._userDefinedRadius === -1 ? bound.radius() : this._userDefinedRadius);
            return radius / vec4.dot(center4, this.computePixelSizeVector(viewport, projMatrix, viewMatrix));
        },

        clampedPixelSize: function(bound, viewport, projMatrix, viewMatrix) {
            return Math.abs(this.pixelSize(bound, viewport, projMatrix, viewMatrix));
        },

        traverse: (function() {
            // avoid to generate variable on the heap to limit garbage collection
            // instead create variable and use the same each time
            var zeroVector = vec3.create();
            var eye = vec3.create();
            var viewModel = mat4.create();
            var mvOverride = mat4.create();

            return function(visitor) {
                var traversalMode = visitor.traversalMode;

                switch (traversalMode) {
                    case NodeVisitor.TRAVERSE_ALL_CHILDREN:
                        for (var index = 0; index < this.children.length; index++) {
                            this.children[index].accept(visitor);
                        }
                        break;

                    case NodeVisitor.TRAVERSE_ACTIVE_CHILDREN:
                        var requiredRange = 0;

                        // Optional LOD camera override (e.g. shadow-map cull): pick
                        // the LOD level as seen by the main camera, not the current
                        // (shadow) camera.
                        var lodOverride = visitor.getLODCameraOverride();

                        if (this._rangeMode === Lod.DISTANCE_FROM_EYE_POINT) {
                            // Calculate distance from viewpoint
                            var matrix = visitor.getCurrentModelViewMatrix();
                            if (lodOverride) {
                                mat4.mul(mvOverride, lodOverride.viewShift, matrix);
                                matrix = mvOverride;
                            }
                            mat4.invert(viewModel, matrix);
                            vec3.transformMat4(eye, zeroVector, viewModel);
                            var d = vec3.distance(this.getBound().center(), eye);
                            requiredRange = d * visitor.getLODScale();
                        } else {
                            // SPOTSCALE: To avoid distorted bounding spheres near edges of screen resulting in
                            // larger pixel area than bounding sphere straight ahead, use radius-based calculation from OSG instead:
                            var vp = lodOverride ? lodOverride.viewport : visitor.getViewport();
                            var proj = lodOverride
                                ? lodOverride.projection
                                : visitor.getCurrentProjectionMatrix();
                            var mv = visitor.getCurrentModelViewMatrix();
                            if (lodOverride) {
                                mat4.mul(mvOverride, lodOverride.viewShift, mv);
                                mv = mvOverride;
                            }
                            requiredRange = this.clampedPixelSize(this.getBound(), vp, proj, mv) / visitor.getLODScale();
                            // Square pixels as before
                            requiredRange = Math.pow(requiredRange, 2.0);
                          
                            /*
                            // Let's calculate pixels on screen
                            var projmatrix = visitor.getCurrentProjectionMatrix();
                            // focal length is the value stored in projmatrix[0]
                            requiredRange = this.projectBoundingSphere(
                                this.getBound(),
                                matrix,
                                projmatrix[0]
                            );
                            // Multiply by a factor to get the real area value
                            requiredRange =
                                requiredRange *
                                visitor.getViewport().width() *
                                visitor.getViewport().width() *
                                0.25 /
                                visitor.getLODScale();
                            */
                            
                            if (requiredRange < 0)
                                requiredRange = this._range[this._range.length - 1][0];
                        }

                        var numChildren = this.children.length;
                        if (this._range.length < numChildren) numChildren = this._range.length;

                        this._activeChildren = [];
                        for (var j = 0; j < numChildren; ++j) {
                            if (
                                this._range[j][0] <= requiredRange &&
                                requiredRange < this._range[j][1]
                            ) {
                                var child = this.children[j];
                                child.accept(visitor);
                                this._activeChildren.push(child);
                            }
                        }
                        break;

                    default:
                        break;
                }
            };
        })()
    }),
    'osg',
    'Lod'
);

export default Lod;
