/*
 * Ported from OpenSceneGraph's osg::Sequence.
 * Copyright (C) 1998-2006 Robert Osfield.
 * Licensed under the OpenSceneGraph Public License, version 0.0 or later.
 */
import utils from 'osg/utils';
import Node from 'osg/Node';
import NodeVisitor from 'osg/NodeVisitor';
import notify from 'osg/notify';

/**
 * A node that displays its children in a time-based sequence.
 * Configure frame times with addChild or setTime, then call setInterval,
 * setDuration and setMode(Sequence.START). Frame durations are multiplied by
 * the absolute speed, as in OpenSceneGraph; a speed of zero holds the frame.
 * getInterval and getDuration return arrays in the order of their setters.
 * An update visitor with a frame stamp advances the sequence, while active
 * traversal visits only the selected child.
 * @class Sequence
 */
var Sequence = function() {
    Node.call(this);
    this.setNumChildrenRequiringUpdateTraversal(1);
    this._value = -1;
    this._now = 0;
    this._start = -1;
    this._frameTime = [];
    this._totalTime = 0;
    this._resetTotalTime = true;
    this._loopMode = Sequence.LOOP;
    this._begin = 0;
    this._end = -1;
    this._speed = 0;
    this._nreps = -1;
    this._nrepsRemain = -1;
    this._step = 0;
    this._defaultTime = 1;
    this._lastFrameTime = 0;
    this._saveRealLastFrameTime = -1;
    this._saveRealLastFrameValue = 0;
    this._mode = Sequence.STOP;
    this._sync = false;
    this._clearOnStop = false;
};

Sequence.LOOP = 0;
Sequence.SWING = 1;
Sequence.START = 0;
Sequence.STOP = 1;
Sequence.PAUSE = 2;
Sequence.RESUME = 3;

utils.createPrototypeNode(
    Sequence,
    utils.objectInherit(Node.prototype, {
        addChild: function(child, time) {
            return this.insertChild(this.children.length, child, time);
        },

        insertChild: function(index, child, time) {
            if (!Number.isInteger(index) || index < 0 || index > this.children.length)
                throw new RangeError('Sequence child index is out of range');
            var oldCount = this.children.length;
            var frameTime = time === undefined ? this._defaultTime : time;
            if (!Number.isFinite(frameTime)) throw new RangeError('Invalid Sequence frame time');
            if (!Node.prototype.addChild.call(this, child)) return false;
            this._restoreLastFrameTime();
            if (index !== this.children.length - 1) {
                this.children.splice(index, 0, this.children.pop());
            }
            if (this._frameTime.length <= oldCount) {
                this._frameTime.splice(index, 0, Math.max(0, frameTime));
            }
            this._resetTotalTime = true;
            return true;
        },

        removeChild: function(child) {
            var index = this.children.indexOf(child);
            if (index === -1) return false;
            this.removeChildren(index, 1);
            return true;
        },

        removeChildren: function(index, count) {
            if (index === undefined) {
                index = 0;
                count = this.children.length;
            }
            if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || count < 0)
                throw new RangeError('Invalid Sequence child range');
            var removed = this.children.slice(index, index + count);
            if (!removed.length) return false;
            this._restoreLastFrameTime();
            for (var i = 0; i < removed.length; i++) {
                Node.prototype.removeChild.call(this, removed[i]);
            }
            this._frameTime.splice(index, removed.length);
            this._resetTotalTime = true;
            return true;
        },

        setValue: function(value) {
            this._value = value;
        },
        getValue: function() {
            return this._value;
        },
        setTime: function(frame, time) {
            if (!Number.isInteger(frame) || frame < 0 || !Number.isFinite(time))
                throw new RangeError('Invalid Sequence frame or time');
            this._restoreLastFrameTime();
            time = Math.max(0, time);
            while (this._frameTime.length <= frame) this._frameTime.push(time);
            this._frameTime[frame] = time;
            this._resetTotalTime = true;
        },
        getTime: function(frame) {
            return frame >= 0 && frame < this._frameTime.length ? this._frameTime[frame] : -1;
        },
        setTimeList: function(times) {
            for (var i = 0; i < times.length; i++) {
                if (!Number.isFinite(times[i]) || times[i] < 0)
                    throw new RangeError('Invalid Sequence frame time');
            }
            this._restoreLastFrameTime();
            this._frameTime = times.slice();
            this._resetTotalTime = true;
        },
        getTimeList: function() {
            return this._frameTime.slice();
        },
        setDefaultTime: function(time) {
            if (!Number.isFinite(time)) throw new RangeError('Invalid Sequence default time');
            this._defaultTime = Math.max(0, time);
        },
        getDefaultTime: function() {
            return this._defaultTime;
        },
        setLastFrameTime: function(time) {
            if (!Number.isFinite(time)) throw new RangeError('Invalid Sequence last frame time');
            this._lastFrameTime = Math.max(0, time);
        },
        getLastFrameTime: function() {
            return this._lastFrameTime;
        },
        getNumFrames: function() {
            return this._frameTime.length;
        },
        setLoopMode: function(mode) {
            this._loopMode = mode;
            this._value = -1;
            this._resetTotalTime = true;
        },
        getLoopMode: function() {
            return this._loopMode;
        },
        setBegin: function(begin) {
            this._begin = begin;
            this._value = -1;
            this._resetTotalTime = true;
        },
        getBegin: function() {
            return this._begin;
        },
        setEnd: function(end) {
            this._end = end;
            this._value = -1;
            this._resetTotalTime = true;
        },
        getEnd: function() {
            return this._end;
        },
        setInterval: function(mode, begin, end) {
            this._loopMode = mode;
            this._begin = begin;
            this._end = end;
            this._value = -1;
            this._resetTotalTime = true;
        },
        getInterval: function() {
            return [this._loopMode, this._begin, this._end];
        },
        setSpeed: function(speed) {
            if (!Number.isFinite(speed)) throw new RangeError('Invalid Sequence speed');
            this._speed = speed;
        },
        getSpeed: function() {
            return this._speed;
        },
        setNumRepeats: function(repeats) {
            this._nreps = repeats < 0 ? -1 : repeats;
            this._nrepsRemain = this._nreps;
        },
        getNumRepeats: function() {
            return this._nreps;
        },
        setDuration: function(speed, repeats) {
            this.setSpeed(speed);
            this.setNumRepeats(repeats === undefined ? -1 : repeats);
        },
        getDuration: function() {
            return [this._speed, this._nreps];
        },
        setMode: function(mode) {
            if (mode === Sequence.START) {
                this._value = -1;
                var begin = this._begin < 0 ? this._frameTime.length - 1 : this._begin;
                var end = this._end < 0 ? this._frameTime.length - 1 : this._end;
                this._step = begin > end ? -1 : 1;
                this._start = -1;
                this._mode = mode;
                this._restoreLastFrameTime();
            } else if (mode === Sequence.STOP) {
                this._mode = mode;
            } else if (mode === Sequence.PAUSE && this._mode === Sequence.START) {
                this._mode = Sequence.PAUSE;
            } else if (mode === Sequence.RESUME && this._mode === Sequence.PAUSE) {
                this._mode = Sequence.START;
            }
        },
        getMode: function() {
            return this._mode;
        },
        setSync: function(sync) {
            this._sync = sync;
        },
        getSync: function() {
            return this._sync;
        },
        setClearOnStop: function(clear) {
            this._clearOnStop = clear;
        },
        getClearOnStop: function() {
            return this._clearOnStop;
        },

        traverse: function(visitor) {
            if (!this.children.length) return;
            var stamp = visitor.getFrameStamp();
            if (stamp) this._now = stamp.getSimulationTime();

            if (
                visitor.getVisitorType() === NodeVisitor.UPDATE_VISITOR &&
                this._mode === Sequence.START &&
                this._frameTime.length
            ) {
                if (!stamp) {
                    notify.warn('osg.Sequence requires a FrameStamp to update');
                } else {
                    this._advance();
                }
            }

            if (visitor.traversalMode === NodeVisitor.TRAVERSE_ACTIVE_CHILDREN) {
                if (
                    !(this._mode === Sequence.STOP && this._clearOnStop) &&
                    this._value >= 0 &&
                    this._value < this.children.length
                )
                    this.children[this._value].accept(visitor);
            } else {
                Node.prototype.traverse.call(this, visitor);
            }
        },

        _advance: function() {
            var begin = this._begin < 0 ? this._frameTime.length - 1 : this._begin;
            var end = this._end < 0 ? this._frameTime.length - 1 : this._end;
            var low = Math.min(begin, end);
            var high = Math.max(begin, end);
            if (low < 0 || high >= this._frameTime.length || high >= this.children.length) {
                notify.warn('osg.Sequence interval is outside the available frames');
                return;
            }

            if (
                this._lastFrameTime > 0 &&
                this._nrepsRemain === 1 &&
                this._saveRealLastFrameTime < 0
            ) {
                var last = -1;
                if (this._loopMode === Sequence.LOOP) {
                    if (
                        (this._step > 0 && this._value !== high) ||
                        (this._step < 0 && this._value !== low)
                    )
                        last = end;
                } else if (this._step > 0 && this._value !== low) {
                    last = high;
                } else if (this._step < 0 && this._value !== high) {
                    last = low;
                }
                if (last >= 0) {
                    this._saveRealLastFrameTime = this._frameTime[last];
                    this._saveRealLastFrameValue = last;
                    this._frameTime[last] = this._lastFrameTime;
                    this._resetTotalTime = true;
                }
            }
            if (this._nrepsRemain === 0) {
                if (
                    !this._clearOnStop ||
                    (this._loopMode === Sequence.LOOP &&
                        ((this._step > 0 && this._value !== high) ||
                            (this._step < 0 && this._value !== low))) ||
                    (this._loopMode === Sequence.SWING &&
                        ((this._step < 0 && this._value !== high) ||
                            (this._step > 0 && this._value !== low)))
                )
                    this._mode = Sequence.STOP;
            }

            this._update(low, high, begin);
            if (this._value < low || this._value > high) {
                notify.warn('osg.Sequence value is outside its interval');
                return;
            }
            var speed = Math.abs(this._speed);
            if (speed === 0) return;
            if (this._now - this._start <= this._frameTime[this._value] * speed) return;

            var next = this._getNextValue(low, high);
            if (
                !this._sync ||
                this._now - this._start <=
                    (this._frameTime[this._value] + this._frameTime[next]) * speed
            ) {
                this._start += this._frameTime[this._value] * speed;
                if ((this._step > 0 && next === high) || (this._step < 0 && next === low)) {
                    if (this._nreps > 0) this._nrepsRemain--;
                    if (this._loopMode === Sequence.SWING) this._step = -this._step;
                }
                this._value = next;
                return;
            }

            var cycleTime = this._totalTime * speed;
            if (cycleTime <= 0) {
                notify.warn('osg.Sequence cannot synchronize a zero-duration sequence');
                return;
            }
            var delta = this._now - this._start;
            var loops = Math.floor(delta / cycleTime);
            if (this._nreps > 0) {
                this._nrepsRemain -= this._loopMode === Sequence.LOOP ? loops : 2 * loops;
                if (this._nrepsRemain <= 0) {
                    this._nrepsRemain = 0;
                    this._mode = Sequence.STOP;
                    notify.warn('osg.Sequence stopped after exhausting its repeats');
                }
            }
            var jump = loops * cycleTime;
            while (delta - jump > this._frameTime[this._value] * speed) {
                jump += this._frameTime[this._value] * speed;
                next = this._getNextValue(low, high);
                if ((this._step > 0 && next === high) || (this._step < 0 && next === low)) {
                    if (this._nreps > 0 && this._nrepsRemain > 0) this._nrepsRemain--;
                    if (this._loopMode === Sequence.SWING) this._step = -this._step;
                }
                this._value = next;
                if (this._nrepsRemain === 0 && !this._clearOnStop) {
                    this._mode = Sequence.STOP;
                    break;
                }
            }
            this._start += jump;
        },

        _restoreLastFrameTime: function() {
            if (this._saveRealLastFrameTime < 0) return;
            this._frameTime[this._saveRealLastFrameValue] = this._saveRealLastFrameTime;
            this._saveRealLastFrameTime = -1;
            this._resetTotalTime = true;
        },

        _getNextValue: function(low, high) {
            var value = this._value + this._step * Math.sign(this._speed);
            if (low === high) return low;
            if (value >= low && value <= high) return value;
            if (this._loopMode === Sequence.LOOP) {
                var size = high - low + 1;
                return ((value - low) % size + size) % size + low;
            }
            return value > high ? 2 * high - value : 2 * low - value;
        },

        _update: function(low, high, begin) {
            if (this._value < 0) {
                this._value = begin;
                this._resetTotalTime = true;
            }
            if (this._start < 0) {
                this._start = this._now;
                this._resetTotalTime = true;
            }
            if (!this._resetTotalTime) return;
            this._totalTime = 0;
            for (var i = low; i <= high; i++) {
                this._totalTime +=
                    this._frameTime[i] *
                    (this._loopMode === Sequence.SWING && i > low && i < high ? 2 : 1);
            }
            this._resetTotalTime = false;
        }
    }),
    'osg',
    'Sequence'
);

export default Sequence;
