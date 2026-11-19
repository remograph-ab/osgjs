import utils from 'osg/utils';
import Lod from 'osg/Lod';
import NodeVisitor from 'osg/NodeVisitor';
import { mat4 } from 'osg/glMatrix';
import { vec3 } from 'osg/glMatrix';
import Program from 'osg/Program';
import StateSet from 'osg/StateSet';
import StateAttribute from 'osg/StateAttribute';
import ColorMask from 'osg/ColorMask';
import Depth from 'osg/Depth';

/**
 *  PagedLOD that can contains paged child nodes
 *  @class PagedLod
 */
var PagedLOD = function() {
    Lod.call(this);
    this._perRangeDataList = [];
    this._loading = false;
    this._expiryTime = 0.0;
    this._expiryFrame = 0;
    this._centerMode = Lod.USER_DEFINED_CENTER;
    this._frameNumberOfLastTraversal = 0;
    this._databasePath = '';
    this._numChildrenThatCannotBeExpired = 0;
};

/**
 *  PerRangeData utility structure to store per range values
 *  @class PerRangeData
 */
var PerRangeData = function() {
    this.filename = '';
    this.function = undefined;
    this.loaded = false;
    this.timeStamp = 0.0;
    this.frameNumber = 0;
    this.frameNumberOfLastTraversal = 0;
    this.dbrequest = undefined;
    // True while a newly attached child waits for its shader programs, see setChildPending
    this.pending = false;
    // Frame number of the first probe traversal of a pending child, or -1
    this.probeFrame = -1;
    // Frame number when the pending state was last decided, so that all culls in a frame agree
    this.decidedFrame = -1;
};

/**
 * Number of frames after the first probe that a pending child is shown at the latest, even if
 * programs are still compiling, in case something keeps compiling for a long time.
 */
PagedLOD.MAX_PENDING_FRAMES = 300;

// State set for probing a pending child: culled and drawn like the real thing, so that its
// shader programs are created (compiled in the background) and its textures uploaded, but
// writing nothing. Neither attribute is part of a shader program hash, so the programs are
// the same as when the child is drawn for real.
var probeStateSet;
var getProbeStateSet = function() {
    if (!probeStateSet) {
        probeStateSet = new StateSet();
        var flags = StateAttribute.ON | StateAttribute.OVERRIDE;
        probeStateSet.setAttributeAndModes(new ColorMask(false, false, false, false), flags);
        probeStateSet.setAttributeAndModes(new Depth(Depth.NEVER, 0.0, 1.0, false), flags);
    }
    return probeStateSet;
};

/** @lends PagedLOD.prototype */
utils.createPrototypeNode(
    PagedLOD,
    utils.objectInherit(Lod.prototype, {
        _copyFrom: function(node, copyOp) {
            Lod.prototype._copyFrom.call(this, node, copyOp);
            this._perRangeDataList = node._perRangeDataList.map(function(source) {
                var data = new PerRangeData();
                data.filename = source.filename;
                data.function = source.function;
                // Children loaded in the source were cloned, while pending requests are made again by the copy
                data.loaded = source.loaded;
                data.timeStamp = source.timeStamp;
                data.frameNumber = source.frameNumber;
                data.frameNumberOfLastTraversal = source.frameNumberOfLastTraversal;
                // A pending child in the source is probed again by the copy
                data.pending = source.pending;
                return data;
            });
            this._expiryTime = node._expiryTime;
            this._expiryFrame = node._expiryFrame;
            this._frameNumberOfLastTraversal = node._frameNumberOfLastTraversal;
            this._databasePath = node._databasePath;
            this._numChildrenThatCannotBeExpired = node._numChildrenThatCannotBeExpired;
        },

        // Functions here
        setRange: function(childNo, min, max) {
            if (childNo >= this._range.length) {
                var r = [];
                r.push([min, min]);
                this._range.push(r);
            }
            this._range[childNo][0] = min;
            this._range[childNo][1] = max;
        },

        setExpiryTime: function(expiryTime) {
            this._expiryTime = expiryTime;
        },

        setDatabasePath: function(path) {
            this._databasePath = path;
        },

        getDatabasePath: function() {
            return this._databasePath;
        },

        setFileName: function(childNo, filename) {
            // May we should expand the vector first?
            if (childNo >= this._perRangeDataList.length) {
                var rd = new PerRangeData();
                rd.filename = filename;
                this._perRangeDataList.push(rd);
            } else {
                this._perRangeDataList[childNo].filename = filename;
            }
        },
        setFunction: function(childNo, func) {
            if (childNo >= this._perRangeDataList.length) {
                var rd = new PerRangeData();
                rd.function = func;
                this._perRangeDataList.push(rd);
            } else {
                this._perRangeDataList[childNo].function = func;
            }
        },

        addChild: function(node, min, max) {
            Lod.prototype.addChild.call(this, node, min, max);
            this._perRangeDataList.push(new PerRangeData());
        },

        addChildNode: function(node) {
            Lod.prototype.addChildNode.call(this, node);
        },

        setFrameNumberOfLastTraversal: function(frameNumber) {
            this._frameNumberOfLastTraversal = frameNumber;
        },

        getFrameNumberOfLastTraversal: function() {
            return this._frameNumberOfLastTraversal;
        },
        setTimeStamp: function(childNo, timeStamp) {
            this._perRangeDataList[childNo].timeStamp = timeStamp;
        },
        setFrameNumber: function(childNo, frameNumber) {
            this._perRangeDataList[childNo].frameNumber = frameNumber;
        },
        setNumChildrenThatCannotBeExpired: function(num) {
            this._numChildrenThatCannotBeExpired = num;
        },
        getNumChildrenThatCannotBeExpired: function() {
            return this._numChildrenThatCannotBeExpired;
        },
        /**
         * Marks a child as pending, e.g. a paged child just attached. A pending child isn't
         * shown until its shader programs have compiled: until then the closest coarser child
         * is shown, while the pending one is culled and drawn writing nothing, which starts
         * the compiles. Without this, the area would be empty while programs compile in the
         * background (see Program.parallelCompile).
         * @param { number } childNo The child number.
         */
        setChildPending: function(childNo) {
            var data = this._perRangeDataList[childNo];
            data.pending = true;
            data.probeFrame = -1;
            data.decidedFrame = -1;
        },
        isChildPending: function(childNo) {
            return childNo < this._perRangeDataList.length && this._perRangeDataList[childNo].pending;
        },
        hasPendingChild: function() {
            for (var i = 0; i < this.children.length && i < this._perRangeDataList.length; ++i) {
                if (this._perRangeDataList[i].pending) return true;
            }
            return false;
        },

        // Decides once per frame whether a pending child is still pending, before culling it
        _isStillPending: function(data, frameNumber) {
            if (data.decidedFrame === frameNumber) return data.pending;
            data.decidedFrame = frameNumber;
            // The probe must have been drawn, which starts any compiles, in an earlier frame
            if (
                data.probeFrame >= 0 &&
                frameNumber > data.probeFrame &&
                (frameNumber - data.probeFrame > PagedLOD.MAX_PENDING_FRAMES ||
                    !Program.hasPendingParallelCompile())
            ) {
                data.pending = false;
            }
            return data.pending;
        },

        // Traverses a child selected for the range, or, if it is pending, probes it and
        // traverses the closest coarser child instead. Returns the mask of handled children.
        _traverseChild: function(visitor, index, handledMask, updateTimeStamp) {
            var data = this._perRangeDataList[index];
            var isCull = visitor.getVisitorType() === NodeVisitor.CULL_VISITOR;
            handledMask |= 1 << index;
            if (data.pending) {
                var frameNumber = visitor.getFrameStamp().getFrameNumber();
                if (!isCull || this._isStillPending(data, frameNumber)) {
                    if (isCull) {
                        // Probe without paging: requests from the probed subgraph would load
                        // deeper levels before this one is even shown
                        var dbhandler = visitor.getDatabaseRequestHandler();
                        visitor.setDatabaseRequestHandler(undefined);
                        visitor.pushStateSet(getProbeStateSet());
                        this.children[index].accept(visitor);
                        visitor.popStateSet();
                        visitor.setDatabaseRequestHandler(dbhandler);
                        if (data.probeFrame < 0) data.probeFrame = frameNumber;
                    }
                    var coarser = index - 1;
                    if (coarser >= 0 && !(handledMask & (1 << coarser))) {
                        if (updateTimeStamp) {
                            this._perRangeDataList[coarser].timeStamp = visitor.getFrameStamp().getSimulationTime();
                            this._perRangeDataList[coarser].frameNumber = frameNumber;
                        }
                        handledMask = this._traverseChild(visitor, coarser, handledMask, updateTimeStamp);
                    }
                    return handledMask;
                }
            }
            this.children[index].accept(visitor);
            return handledMask;
        },

        getDatabaseRequest: function(childNo) {
            return this._perRangeDataList[childNo].dbrequest;
        },
        removeExpiredChildren: function(expiryTime, expiryFrame, removedChildren) {
            if (this.children.length <= this._numChildrenThatCannotBeExpired) return;
            var i = this.children.length - 1;
            var timed, framed;
            timed = this._perRangeDataList[i].timeStamp + this._expiryTime;
            framed = this._perRangeDataList[i].frameNumber + this._expiryFrame;
            if (
                timed < expiryTime &&
                framed < expiryFrame &&
                (this._perRangeDataList[i].filename.length > 0 ||
                    this._perRangeDataList[i].function !== undefined)
            ) {
                removedChildren.push(this.children[i]);
                this.removeChild(this.children[i]);
                this._perRangeDataList[i].loaded = false;
                this._perRangeDataList[i].pending = false;
                if (this._perRangeDataList[i].dbrequest !== undefined) {
                    this._perRangeDataList[i].dbrequest._groupExpired = true;
                }
            }
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
                var updateTimeStamp = false;

                if (visitor.getVisitorType() === NodeVisitor.CULL_VISITOR) {
                    this._frameNumberOfLastTraversal = visitor.getFrameStamp().getFrameNumber();
                    updateTimeStamp = true;
                }

                switch (traversalMode) {
                    case NodeVisitor.TRAVERSE_ALL_CHILDREN:
                        for (var index = 0; index < this.children.length; index++) {
                            this.children[index].accept(visitor);
                        }
                        break;

                    case NodeVisitor.TRAVERSE_ACTIVE_CHILDREN:
                        var requiredRange = 0, distance = 0;

                        // Optional LOD camera override (e.g. shadow-map cull): pick
                        // the LOD level as seen by the main camera, not the current
                        // (shadow) camera, so casters match the receiver's LOD.
                        var lodOverride = visitor.getLODCameraOverride
                            ? visitor.getLODCameraOverride()
                            : undefined;

                        if (this._rangeMode === Lod.DISTANCE_FROM_EYE_POINT) {
                            // Calculate distance from viewpoint
                            // Only need for this with distance from eye point now
                            var matrix = visitor.getCurrentModelViewMatrix();
                            if (lodOverride) {
                                mat4.mul(mvOverride, lodOverride.viewShift, matrix);
                                matrix = mvOverride;
                            }
                            mat4.invert(viewModel, matrix);
                            vec3.transformMat4(eye, zeroVector, viewModel);
                            distance = vec3.distance(this.getBound().center(), eye);

                            requiredRange = distance * visitor.getLODScale();
                        } else {
                            // To avoid distorted bounding spheres near edges of screen resulting in
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
                            // Calculate pixels on screen
                            var projmatrix = visitor.getCurrentProjectionMatrix();
                            // focal length is the value stored in projmatrix[0]
                            requiredRange = this.projectBoundingSphere(
                                this.getBound(),
                                matrix,
                                projmatrix[0]
                            );
                            // Get the real area value and apply LODScale
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

                        var needToLoadChild = false;
                        var handledMask = 0;
                        var dbhandler = visitor.getDatabaseRequestHandler();
                        for (var j = 0; j < this._range.length; ++j) {
                            if (
                                this._range[j][0] <= requiredRange &&
                                requiredRange < this._range[j][1]
                            ) {
                                if (j < this.children.length) {
                                    if (updateTimeStamp) {
                                        this._perRangeDataList[
                                            j
                                        ].timeStamp = visitor.getFrameStamp().getSimulationTime();
                                        this._perRangeDataList[
                                            j
                                        ].frameNumber = visitor.getFrameStamp().getFrameNumber();
                                    }

                                    if (!(handledMask & (1 << j))) {
                                        handledMask = this._traverseChild(visitor, j, handledMask, updateTimeStamp);
                                    }
                                } else {
                                    needToLoadChild = true;
                                }
                            }
                            else if (dbhandler !== undefined && this._perRangeDataList[j].dbrequest !== undefined && this._perRangeDataList[j].dbrequest._function === undefined) {
                                // If there is a pending request for this node although we are now far from it, throw it out of the queue
                                // (if it's not loaded by function so that we can trust the URL)
                                dbhandler.removeRequest(this._databasePath + this._perRangeDataList[j].filename);
                                this._perRangeDataList[j].dbrequest = undefined;
                            }
                        }

                        if (needToLoadChild) {
                            var numChildren = this.children.length;
                            if (numChildren > 0 && !(handledMask & (1 << (numChildren - 1)))) {
                                if (updateTimeStamp) {
                                    this._perRangeDataList[
                                        numChildren - 1
                                    ].timeStamp = visitor.getFrameStamp().getSimulationTime();
                                    this._perRangeDataList[
                                        numChildren - 1
                                    ].frameNumber = visitor.getFrameStamp().getFrameNumber();
                                }

                                handledMask = this._traverseChild(visitor, numChildren - 1, handledMask, updateTimeStamp);
                            }
                            // now request the loading of the next unloaded child.
                            // Skip entirely when no DatabaseRequestHandler is set
                            // (e.g. the shadow camera traversal): paging must only
                            // be driven by the main camera.
                            if (dbhandler !== undefined && numChildren < this._perRangeDataList.length) {
                                // compute priority from where abouts in the required range the distance falls.
                                var priority =
                                    (this._range[numChildren][0] - requiredRange) /
                                    (this._range[numChildren][1] - this._range[numChildren][0]);
                                if (this._rangeMode === Lod.PIXEL_SIZE_ON_SCREEN) {
                                    priority = -priority;
                                }
                                // Here we do the request
                                var group = visitor.nodePath[visitor.nodePath.length - 1];
                                var lastRange = this._perRangeDataList[numChildren];
                                if (lastRange.loaded === false) {
                                    var filename = lastRange.filename;
                                    lastRange.loaded = true;
                                    lastRange.dbrequest = dbhandler.requestNodeFile(
                                        lastRange.function,
                                        filename === undefined || filename === '' ? '' : this._databasePath + filename,
                                        group,
                                        visitor.getFrameStamp().getSimulationTime(),
                                        priority,
                                        visitor.nodePath.length,
                                        requiredRange,
                                        distance
                                    );
                                } else {
                                    // Update timestamp of the request.
                                    if (
                                        lastRange.dbrequest !== undefined
                                    ) {
                                        lastRange.dbrequest._timeStamp = visitor.getFrameStamp().getSimulationTime();
                                        lastRange.dbrequest._priority = priority;
                                        lastRange.dbrequest._depth = visitor.nodePath.length;
                                        lastRange.dbrequest._requiredRange = requiredRange;
                                        lastRange.dbrequest._distance = distance;
                                    } else {
                                        // The DB request is undefined, so the DBPager was not accepting requests, we need to ask for the child again.
                                        lastRange.loaded = false;
                                    }
                                }
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
    'PagedLOD'
);

export default PagedLOD;
