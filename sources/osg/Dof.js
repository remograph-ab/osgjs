/*
 * Ported from OpenSceneGraph's osgSim::DOFTransform.
 * Copyright (C) 1998-2006 Robert Osfield.
 * Licensed under the OpenSceneGraph Public License, version 0.0 or later.
 */
import utils from 'osg/utils';
import { mat4, vec3 } from 'osg/glMatrix';
import Transform from 'osg/Transform';
import NodeVisitor from 'osg/NodeVisitor';
import TransformEnums from 'osg/transformEnums';

// Limitation flag bits, from left to right, as in the OpenFlight DOF record
var TRANSLATION_X_LIMIT_BIT = 0x80000000 >>> 0;
var TRANSLATION_Y_LIMIT_BIT = 0x80000000 >>> 1;
var TRANSLATION_Z_LIMIT_BIT = 0x80000000 >>> 2;
var ROTATION_PITCH_LIMIT_BIT = 0x80000000 >>> 3;
var ROTATION_ROLL_LIMIT_BIT = 0x80000000 >>> 4;
var ROTATION_YAW_LIMIT_BIT = 0x80000000 >>> 5;
var SCALE_X_LIMIT_BIT = 0x80000000 >>> 6;
var SCALE_Y_LIMIT_BIT = 0x80000000 >>> 7;
var SCALE_Z_LIMIT_BIT = 0x80000000 >>> 8;

// Per component [limitation bit, increasing flag bit]. HPR components are heading
// (about z), pitch (about x) and roll (about y).
var TRANSLATE_BITS = [
    [TRANSLATION_X_LIMIT_BIT, 1 << 0],
    [TRANSLATION_Y_LIMIT_BIT, 1 << 1],
    [TRANSLATION_Z_LIMIT_BIT, 1 << 2]
];
var HPR_BITS = [
    [ROTATION_YAW_LIMIT_BIT, 1 << 5],
    [ROTATION_PITCH_LIMIT_BIT, 1 << 3],
    [ROTATION_ROLL_LIMIT_BIT, 1 << 4]
];
var SCALE_BITS = [
    [SCALE_X_LIMIT_BIT, 1 << 6],
    [SCALE_Y_LIMIT_BIT, 1 << 7],
    [SCALE_Z_LIMIT_BIT, 1 << 8]
];

var TWO_PI = 2 * Math.PI;
var tmpValue = vec3.create64();

var setVec3 = function(out, value, name) {
    if (!value || value.length !== 3 || !Array.prototype.every.call(value, Number.isFinite))
        throw new TypeError('Invalid Dof ' + name);
    vec3.copy(out, value);
};

var setMat4 = function(out, value, name) {
    if (!value || value.length !== 16 || !Array.prototype.every.call(value, Number.isFinite))
        throw new TypeError('Invalid Dof ' + name);
    mat4.copy(out, value);
};

/**
 * Dof - a degree of freedom transform, encapsulating the Multigen DOF behavior of
 * osgSim::DOFTransform. The local matrix is
 * InversePut * Translate * Rotations (in HPRMultOrder) * Scale * Put,
 * using the current translation, rotation (heading, pitch, roll in radians) and scale.
 * The current values are the initial state, and are what is shown when animation is off.
 * When animation is on, an update traversal with a frame stamp increments the current
 * values by their increments per second, bouncing between min and max for limited
 * components. Unlike OpenSceneGraph, animation starts from the current values without
 * a time jump, and unlimited rotations are wrapped to keep precision.
 * @class Dof
 * @inherits Transform
 */
var Dof = function() {
    Transform.call(this);
    this._minHPR = vec3.create64();
    this._maxHPR = vec3.create64();
    this._currentHPR = vec3.create64();
    this._incrementHPR = vec3.create64();
    this._minTranslate = vec3.create64();
    this._maxTranslate = vec3.create64();
    this._currentTranslate = vec3.create64();
    this._incrementTranslate = vec3.create64();
    this._minScale = vec3.fromValues64(1, 1, 1);
    this._maxScale = vec3.fromValues64(1, 1, 1);
    this._currentScale = vec3.fromValues64(1, 1, 1);
    this._incrementScale = vec3.create64();
    this._putMatrix = mat4.create();
    this._inversePutMatrix = mat4.create();
    this._limitationFlags = 0;
    this._animationOn = false;
    this._increasingFlags = 0xffff;
    this._multOrder = Dof.PRH;
    this._previousFrameNumber = undefined;
    this._previousTime = 0;
    this.matrix = mat4.create();
    this._matrixDirty = true;
};

Dof.PRH = 0;
Dof.PHR = 1;
Dof.HPR = 2;
Dof.HRP = 3;
Dof.RPH = 4;
Dof.RHP = 5;
Dof.MULT_ORDER_NAMES = ['PRH', 'PHR', 'HPR', 'HRP', 'RPH', 'RHP'];

Dof.TRANSLATION_X_LIMIT_BIT = TRANSLATION_X_LIMIT_BIT;
Dof.TRANSLATION_Y_LIMIT_BIT = TRANSLATION_Y_LIMIT_BIT;
Dof.TRANSLATION_Z_LIMIT_BIT = TRANSLATION_Z_LIMIT_BIT;
Dof.ROTATION_PITCH_LIMIT_BIT = ROTATION_PITCH_LIMIT_BIT;
Dof.ROTATION_ROLL_LIMIT_BIT = ROTATION_ROLL_LIMIT_BIT;
Dof.ROTATION_YAW_LIMIT_BIT = ROTATION_YAW_LIMIT_BIT;
Dof.SCALE_X_LIMIT_BIT = SCALE_X_LIMIT_BIT;
Dof.SCALE_Y_LIMIT_BIT = SCALE_Y_LIMIT_BIT;
Dof.SCALE_Z_LIMIT_BIT = SCALE_Z_LIMIT_BIT;

/** Limitation bit per HPR component (heading, pitch, roll) */
Dof.HPR_LIMIT_BITS = HPR_BITS.map(function(bits) {
    return bits[0];
});
/** Increasing flag bit per HPR component (heading, pitch, roll) */
Dof.HPR_INCREASING_BITS = HPR_BITS.map(function(bits) {
    return bits[1];
});
/** Limitation bit per translation component (x, y, z) */
Dof.TRANSLATE_LIMIT_BITS = TRANSLATE_BITS.map(function(bits) {
    return bits[0];
});
/** Increasing flag bit per translation component (x, y, z) */
Dof.TRANSLATE_INCREASING_BITS = TRANSLATE_BITS.map(function(bits) {
    return bits[1];
});

/** @lends Dof.prototype */
utils.createPrototypeNode(
    Dof,
    utils.objectInherit(Transform.prototype, {
        setMinHPR: function(hpr) {
            setVec3(this._minHPR, hpr, 'MinHPR');
        },
        getMinHPR: function() {
            return this._minHPR;
        },
        setMaxHPR: function(hpr) {
            setVec3(this._maxHPR, hpr, 'MaxHPR');
        },
        getMaxHPR: function() {
            return this._maxHPR;
        },
        setIncrementHPR: function(hpr) {
            setVec3(this._incrementHPR, hpr, 'IncrementHPR');
        },
        getIncrementHPR: function() {
            return this._incrementHPR;
        },
        setCurrentHPR: function(hpr) {
            setVec3(this._currentHPR, hpr, 'CurrentHPR');
            this._dirtyMatrix();
        },
        getCurrentHPR: function() {
            return this._currentHPR;
        },
        updateCurrentHPR: function(hpr) {
            this._updateCurrent(this._currentHPR, hpr, this._minHPR, this._maxHPR, HPR_BITS);
        },

        setMinTranslate: function(translate) {
            setVec3(this._minTranslate, translate, 'MinTranslate');
        },
        getMinTranslate: function() {
            return this._minTranslate;
        },
        setMaxTranslate: function(translate) {
            setVec3(this._maxTranslate, translate, 'MaxTranslate');
        },
        getMaxTranslate: function() {
            return this._maxTranslate;
        },
        setIncrementTranslate: function(translate) {
            setVec3(this._incrementTranslate, translate, 'IncrementTranslate');
        },
        getIncrementTranslate: function() {
            return this._incrementTranslate;
        },
        setCurrentTranslate: function(translate) {
            setVec3(this._currentTranslate, translate, 'CurrentTranslate');
            this._dirtyMatrix();
        },
        getCurrentTranslate: function() {
            return this._currentTranslate;
        },
        updateCurrentTranslate: function(translate) {
            this._updateCurrent(
                this._currentTranslate,
                translate,
                this._minTranslate,
                this._maxTranslate,
                TRANSLATE_BITS
            );
        },

        setMinScale: function(scale) {
            setVec3(this._minScale, scale, 'MinScale');
        },
        getMinScale: function() {
            return this._minScale;
        },
        setMaxScale: function(scale) {
            setVec3(this._maxScale, scale, 'MaxScale');
        },
        getMaxScale: function() {
            return this._maxScale;
        },
        setIncrementScale: function(scale) {
            setVec3(this._incrementScale, scale, 'IncrementScale');
        },
        getIncrementScale: function() {
            return this._incrementScale;
        },
        setCurrentScale: function(scale) {
            setVec3(this._currentScale, scale, 'CurrentScale');
            this._dirtyMatrix();
        },
        getCurrentScale: function() {
            return this._currentScale;
        },
        updateCurrentScale: function(scale) {
            this._updateCurrent(
                this._currentScale,
                scale,
                this._minScale,
                this._maxScale,
                SCALE_BITS
            );
        },

        setPutMatrix: function(put) {
            setMat4(this._putMatrix, put, 'PutMatrix');
            this._dirtyMatrix();
        },
        getPutMatrix: function() {
            return this._putMatrix;
        },
        setInversePutMatrix: function(inversePut) {
            setMat4(this._inversePutMatrix, inversePut, 'InversePutMatrix');
            this._dirtyMatrix();
        },
        getInversePutMatrix: function() {
            return this._inversePutMatrix;
        },

        setLimitationFlags: function(flags) {
            if (!Number.isInteger(flags)) throw new TypeError('Invalid Dof LimitationFlags');
            this._limitationFlags = flags >>> 0;
        },
        getLimitationFlags: function() {
            return this._limitationFlags;
        },

        /**
         * Sets the animation direction bits (1 is increasing), see the *_INCREASING_BITS.
         * Not available in OpenSceneGraph, where they are only changed by limits.
         */
        setIncreasingFlags: function(flags) {
            if (!Number.isInteger(flags)) throw new TypeError('Invalid Dof IncreasingFlags');
            this._increasingFlags = flags & 0xffff;
        },
        getIncreasingFlags: function() {
            return this._increasingFlags;
        },

        setHPRMultOrder: function(order) {
            if (!Number.isInteger(order) || order < Dof.PRH || order > Dof.RHP)
                throw new RangeError('Invalid Dof HPRMultOrder');
            this._multOrder = order;
            this._dirtyMatrix();
        },
        getHPRMultOrder: function() {
            return this._multOrder;
        },

        setAnimationOn: function(on) {
            on = !!on;
            if (this._animationOn === on) return;
            this._animationOn = on;
            // Restart from the current values, without a jump for the time animation was off
            this._previousFrameNumber = undefined;
            this.setNumChildrenRequiringUpdateTraversal(
                this.getNumChildrenRequiringUpdateTraversal() + (on ? 1 : -1)
            );
        },
        getAnimationOn: function() {
            return this._animationOn;
        },

        /**
         * Increments or decrements all current values by their increments.
         * @param {number} deltaTime The time step in seconds.
         */
        animate: function(deltaTime) {
            if (!this._animationOn) return;
            this._step(this._currentTranslate, this._incrementTranslate, TRANSLATE_BITS, deltaTime);
            this.updateCurrentTranslate(tmpValue);
            this._step(this._currentHPR, this._incrementHPR, HPR_BITS, deltaTime);
            // Unlimited rotations would otherwise grow without bounds and lose precision
            for (var i = 0; i < 3; i++) {
                if (!(this._limitationFlags & HPR_BITS[i][0]) && Math.abs(tmpValue[i]) > Math.PI)
                    tmpValue[i] -= TWO_PI * Math.round(tmpValue[i] / TWO_PI);
            }
            this.updateCurrentHPR(tmpValue);
            this._step(this._currentScale, this._incrementScale, SCALE_BITS, deltaTime);
            this.updateCurrentScale(tmpValue);
        },

        traverse: function(visitor) {
            if (visitor.getVisitorType() === NodeVisitor.UPDATE_VISITOR) {
                var stamp = visitor.getFrameStamp();
                // Only once per frame, since the node can be shared by multiple parents
                if (stamp && stamp.getFrameNumber() !== this._previousFrameNumber) {
                    var time = stamp.getSimulationTime();
                    if (this._previousFrameNumber !== undefined)
                        this.animate(Math.max(0, time - this._previousTime));
                    this._previousFrameNumber = stamp.getFrameNumber();
                    this._previousTime = time;
                }
            }
            Transform.prototype.traverse.call(this, visitor);
        },

        /**
         * The local matrix, i.e. InversePut * Translate * Rotations * Scale * Put.
         * Read only, it is recomputed from the current values.
         */
        getMatrix: function() {
            if (this._matrixDirty) this._computeMatrix();
            return this.matrix;
        },

        computeLocalToWorldMatrix: function(matrix /*, nodeVisitor */) {
            var local = this.getMatrix();
            if (this.referenceFrame === TransformEnums.RELATIVE_RF) {
                mat4.mul(matrix, matrix, local);
            } else {
                mat4.copy(matrix, local);
            }
            return true;
        },

        computeWorldToLocalMatrix: (function() {
            var inverse = mat4.create();
            return function(matrix /*, nodeVisitor */) {
                if (!mat4.invert(inverse, this.getMatrix())) mat4.identity(inverse);
                if (this.referenceFrame === TransformEnums.RELATIVE_RF) {
                    mat4.mul(matrix, inverse, matrix);
                } else {
                    mat4.copy(matrix, inverse);
                }
                return true;
            };
        })(),

        _dirtyMatrix: function() {
            this._matrixDirty = true;
            this.dirtyBound();
        },

        _step: function(current, increment, bits, deltaTime) {
            for (var i = 0; i < 3; i++) {
                var delta = increment[i] * deltaTime;
                tmpValue[i] = current[i] + (this._increasingFlags & bits[i][1] ? delta : -delta);
            }
        },

        _updateCurrent: function(current, value, min, max, bits) {
            for (var i = 0; i < 3; i++) {
                var flag = bits[i][1];
                if (!(this._limitationFlags & bits[i][0])) {
                    current[i] = value[i];
                } else if (min[i] !== max[i]) {
                    // min == max is an effective constraint, so the value is kept as is
                    current[i] = value[i];
                    if (current[i] < min[i]) {
                        current[i] = min[i];
                        this._increasingFlags |= flag;
                    } else if (current[i] > max[i]) {
                        current[i] = max[i];
                        this._increasingFlags &= ~flag;
                    }
                }
            }
            this._dirtyMatrix();
        },

        _computeMatrix: function() {
            var m = this.matrix;
            var hpr = this._currentHPR;
            mat4.copy(m, this._inversePutMatrix);
            mat4.translate(m, m, this._currentTranslate);
            // The rotations are applied in the order named, the first one being outermost,
            // which equals the pre-multiplication order of osgSim::DOFTransform.
            var order = Dof.MULT_ORDER_NAMES[this._multOrder];
            for (var i = 0; i < 3; i++) {
                var axis = order[i];
                if (axis === 'H') mat4.rotateZ(m, m, hpr[0]);
                else if (axis === 'P') mat4.rotateX(m, m, hpr[1]);
                else mat4.rotateY(m, m, hpr[2]);
            }
            mat4.scale(m, m, this._currentScale);
            mat4.mul(m, m, this._putMatrix);
            this._matrixDirty = false;
        }
    }),
    'osg',
    'Dof'
);

export default Dof;
