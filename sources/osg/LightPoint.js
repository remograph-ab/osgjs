import utils from 'osg/utils';
import OSGObject from 'osg/Object';
import lightPointUtils from 'osg/lightPointUtils';

var finite = lightPointUtils.number;
var vector = lightPointUtils.vector;

/**
 * A light-point record, not a scene-graph light source. Add records to a
 * LightPointNode to render them. Call node.dirtyLightPoints() after editing
 * positions, radii or blending modes in a node.
 */
var LightPoint = function(position, color) {
    OSGObject.call(this);
    this._on = true;
    this._position = position === undefined ? [0, 0, 0] : vector(position, 3, 'position');
    this._color = color === undefined ? [1, 1, 1, 1] : vector(color, 4, 'color');
    this._intensity = 1;
    this._radius = 1;
    this._sector = undefined;
    this._blinkSequence = undefined;
    this._blendingMode = LightPoint.BLENDED;
};

LightPoint.ADDITIVE = 0;
LightPoint.BLENDED = 1;

utils.createPrototypeObject(
    LightPoint,
    utils.objectInherit(OSGObject.prototype, {
        /**
         * Clones this light point. Its sector and blink sequence are copied, but kept shared within the copy operation.
         * @param { CopyOp } copyOp The copy operation.
         * @returns { LightPoint } The copy.
         */
        clone: function(copyOp) {
            var copy = new LightPoint(this._position.slice(), this._color.slice());
            copy.setName(this.getName());
            copy.setUserData(this.getUserData());
            copy._on = this._on;
            copy._intensity = this._intensity;
            copy._radius = this._radius;
            copy._blendingMode = this._blendingMode;
            copy._sector = copyOp.copyData(this._sector);
            copy._blinkSequence = copyOp.copyData(this._blinkSequence);
            return copy;
        },

        setOn: function(on) {
            if (typeof on !== 'boolean') throw new TypeError('Invalid LightPoint on flag');
            this._on = on;
        },
        getOn: function() {
            return this._on;
        },
        setPosition: function(position) {
            this._position = vector(position, 3, 'position');
        },
        getPosition: function() {
            return this._position;
        },
        setColor: function(color) {
            this._color = vector(color, 4, 'color');
        },
        getColor: function() {
            return this._color;
        },
        setIntensity: function(intensity) {
            this._intensity = finite(intensity, 'intensity');
        },
        getIntensity: function() {
            return this._intensity;
        },
        setRadius: function(radius) {
            if (finite(radius, 'radius') < 0) throw new RangeError('Negative LightPoint radius');
            this._radius = radius;
        },
        getRadius: function() {
            return this._radius;
        },
        setBlendingMode: function(mode) {
            if (mode !== LightPoint.ADDITIVE && mode !== LightPoint.BLENDED)
                throw new RangeError('Invalid LightPoint blending mode');
            this._blendingMode = mode;
        },
        getBlendingMode: function() {
            return this._blendingMode;
        },
        setSector: function(sector) {
            this._sector =
                sector === undefined || sector === null
                    ? undefined
                    : lightPointUtils.sector(sector);
        },
        getSector: function() {
            return this._sector;
        },
        setBlinkSequence: function(sequence) {
            this._blinkSequence =
                sequence === undefined || sequence === null
                    ? undefined
                    : lightPointUtils.blinkSequence(sequence);
        },
        getBlinkSequence: function() {
            return this._blinkSequence;
        }
    }),
    'osg',
    'LightPoint'
);

export default LightPoint;
