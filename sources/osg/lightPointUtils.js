import { vec3 } from 'osg/glMatrix';

var number = function(value, name, fallback) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (!Number.isFinite(value)) throw new RangeError('Invalid light-point ' + name);
    return value;
};

var vector = function(value, size, name) {
    if (!value || value.length !== size) throw new RangeError('Invalid light-point ' + name);
    return Array.prototype.map.call(value, function(component) {
        return number(component, name);
    });
};

var object = function(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('Invalid light-point ' + name);
    return value;
};

var sector = function(value) {
    object(value, 'sector');
    var result = { Type: value.Type };
    var type = result.Type;
    var azimuth = type === 'AzimSector' || type === 'AzimElevationSector';
    var elevation = type === 'ElevationSector' || type === 'AzimElevationSector';
    if (azimuth) {
        result.MinAzimuth = number(value.MinAzimuth, 'minimum azimuth', -Math.PI);
        result.MaxAzimuth = number(value.MaxAzimuth, 'maximum azimuth', Math.PI);
        result.AzimuthFadeAngle = number(value.AzimuthFadeAngle, 'azimuth fade', 0);
        if (result.MaxAzimuth < result.MinAzimuth || result.AzimuthFadeAngle < 0)
            throw new RangeError('Invalid light-point azimuth interval');
    }
    if (elevation) {
        result.MinElevation = number(value.MinElevation, 'minimum elevation', -Math.PI / 2);
        result.MaxElevation = number(value.MaxElevation, 'maximum elevation', Math.PI / 2);
        result.ElevationFadeAngle = number(value.ElevationFadeAngle, 'elevation fade', 0);
        result.MinFadeElevation = number(
            value.MinFadeElevation,
            'minimum elevation fade',
            Math.max(-Math.PI / 2, result.MinElevation - result.ElevationFadeAngle)
        );
        result.MaxFadeElevation = number(
            value.MaxFadeElevation,
            'maximum elevation fade',
            Math.min(Math.PI / 2, result.MaxElevation + result.ElevationFadeAngle)
        );
        if (
            result.MaxElevation < result.MinElevation ||
            result.ElevationFadeAngle < 0 ||
            result.MinFadeElevation > result.MinElevation ||
            result.MaxFadeElevation < result.MaxElevation
        )
            throw new RangeError('Invalid light-point elevation interval');
    }
    if (type === 'ConeSector') {
        result.Axis = vector(value.Axis === undefined ? [0, 0, 1] : value.Axis, 3, 'cone axis');
        if (vec3.length(result.Axis) === 0) throw new RangeError('Zero light-point cone axis');
        vec3.normalize(result.Axis, result.Axis);
        result.Angle = number(value.Angle, 'cone angle', Math.PI);
        result.FadeAngle = number(value.FadeAngle, 'cone fade', 0);
        if (result.Angle < 0 || result.FadeAngle < 0)
            throw new RangeError('Invalid light-point cone angle');
    } else if (type === 'DirectionalSector') {
        result.Direction = vector(
            value.Direction === undefined ? [0, 0, 1] : value.Direction,
            3,
            'direction'
        );
        result.HorizLobeAngle = number(value.HorizLobeAngle, 'horizontal lobe angle', Math.PI * 2);
        result.VertLobeAngle = number(value.VertLobeAngle, 'vertical lobe angle', Math.PI * 2);
        result.LobeRollAngle = number(value.LobeRollAngle, 'lobe roll', 0);
        result.FadeAngle = number(value.FadeAngle, 'directional fade', 0);
        result.HorizFadeAngle = number(value.HorizFadeAngle, 'horizontal fade', result.FadeAngle);
        result.VertFadeAngle = number(value.VertFadeAngle, 'vertical fade', result.FadeAngle);
        if (
            result.HorizLobeAngle < 0 ||
            result.VertLobeAngle < 0 ||
            result.FadeAngle < 0 ||
            result.HorizFadeAngle < 0 ||
            result.VertFadeAngle < 0
        )
            throw new RangeError('Invalid light-point directional angle');
    } else if (!azimuth && !elevation && type !== 'ConeSector') {
        throw new RangeError('Unsupported light-point sector ' + type);
    }
    return result;
};

var sequenceGroup = function(value) {
    object(value, 'sequence group');
    return { BaseTime: number(value.BaseTime, 'sequence group base time', 0) };
};

var blinkSequence = function(value) {
    object(value, 'blink sequence');
    var pulses = value.Pulses === undefined ? [] : value.Pulses;
    if (!Array.isArray(pulses)) throw new TypeError('Invalid light-point pulses');
    var duration = 0;
    var result = {
        PhaseShift: number(value.PhaseShift, 'blink phase', 0),
        Pulses: pulses.map(function(pulse) {
            object(pulse, 'pulse');
            var time = number(pulse.Duration, 'pulse duration');
            if (time < 0) throw new RangeError('Light-point pulse duration must be nonnegative');
            duration += time;
            return { Duration: time, Color: vector(pulse.Color, 4, 'pulse color') };
        })
    };
    result.PulsePeriod = number(value.PulsePeriod, 'pulse period', duration);
    if (
        !Number.isFinite(duration) ||
        result.PulsePeriod < 0 ||
        (pulses.length && (result.PulsePeriod === 0 || duration === 0))
    )
        throw new RangeError('Invalid light-point pulse period');
    if (value.SequenceGroup !== undefined)
        result.SequenceGroup = sequenceGroup(value.SequenceGroup);
    return result;
};

var system = function(value) {
    object(value, 'system');
    var result = {
        Intensity: number(value.Intensity, 'system intensity', 1),
        AnimationState: value.AnimationState === undefined ? 'ANIMATION_ON' : value.AnimationState
    };
    if (['ANIMATION_ON', 'ANIMATION_OFF', 'ANIMATION_RANDOM'].indexOf(result.AnimationState) === -1)
        throw new RangeError('Invalid light-point animation state');
    return result;
};

var ramp = function(value, inner, outer) {
    if (value >= inner) return 1;
    if (value <= outer) return 0;
    return (value - outer) / (inner - outer);
};

var azimuthFactor = function(s, v) {
    var center = (s.MinAzimuth + s.MaxAzimuth) / 2;
    var half = (s.MaxAzimuth - s.MinAzimuth) / 2;
    var length = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    var d = v[0] * Math.sin(center) + v[1] * Math.cos(center);
    return ramp(
        d,
        Math.cos(half) * length,
        Math.cos(Math.min(Math.PI, half + s.AzimuthFadeAngle)) * length
    );
};

var elevationFactor = function(s, v) {
    var length = vec3.length(v);
    var low = Math.sin(s.MinElevation) * length;
    var high = Math.sin(s.MaxElevation) * length;
    var outerLow = Math.sin(s.MinFadeElevation) * length;
    var outerHigh = Math.sin(s.MaxFadeElevation) * length;
    if (v[2] < outerLow || v[2] > outerHigh) return 0;
    if (v[2] > high) return (v[2] - outerHigh) / (high - outerHigh);
    if (v[2] < low) return (v[2] - outerLow) / (low - outerLow);
    return 1;
};

var sectorFactor = function(s, v) {
    if (!s) return 1;
    if (s.Type === 'AzimSector') return azimuthFactor(s, v);
    if (s.Type === 'ElevationSector') return elevationFactor(s, v);
    if (s.Type === 'AzimElevationSector')
        return Math.min(azimuthFactor(s, v), elevationFactor(s, v));
    if (s.Type === 'ConeSector')
        return ramp(
            vec3.dot(v, s.Axis),
            Math.cos(s.Angle) * vec3.length(v),
            Math.cos(s.Angle + s.FadeAngle) * vec3.length(v)
        );
    var heading = Math.atan2(s.Direction[0], s.Direction[1]);
    var pitch = Math.atan2(
        s.Direction[2],
        Math.sqrt(s.Direction[0] * s.Direction[0] + s.Direction[1] * s.Direction[1])
    );
    var roll = s.LobeRollAngle;
    var x1 = Math.cos(heading) * v[0] - Math.sin(heading) * v[1];
    var y1 = Math.sin(heading) * v[0] + Math.cos(heading) * v[1];
    var y2 = Math.cos(pitch) * y1 + Math.sin(pitch) * v[2];
    var z2 = -Math.sin(pitch) * y1 + Math.cos(pitch) * v[2];
    var x = Math.cos(roll) * x1 - Math.sin(roll) * z2;
    var z = Math.sin(roll) * x1 + Math.cos(roll) * z2;
    var verticalLength = Math.sqrt(y2 * y2 + z * z);
    var horizontalLength = Math.sqrt(x * x + y2 * y2);
    var vertical = verticalLength ? y2 / verticalLength : 0;
    var horizontal = horizontalLength ? y2 / horizontalLength : 0;
    if (vertical < 0) horizontal = -horizontal;
    return (
        ramp(
            vertical,
            Math.cos(s.VertLobeAngle / 2),
            Math.cos(s.VertLobeAngle / 2 + s.VertFadeAngle)
        ) *
        ramp(
            horizontal,
            Math.cos(s.HorizLobeAngle / 2),
            Math.cos(s.HorizLobeAngle / 2 + s.HorizFadeAngle)
        )
    );
};

var pulseColor = function(sequence, time, interval, result) {
    for (var c = 0; c < 4; c++) result[c] = 1;
    if (!sequence || !sequence.Pulses.length) return result;
    var pulses = sequence.Pulses;
    var total = 0;
    for (var i = 0; i < pulses.length; i++) total += pulses[i].Duration;
    var base = sequence.SequenceGroup ? sequence.SequenceGroup.BaseTime : 0;
    var t = time - base - sequence.PhaseShift;
    t -= Math.floor(t / sequence.PulsePeriod) * sequence.PulsePeriod;
    // setPulse() in OSG may leave PulsePeriod different from the pulse sum.
    if (t > total) t = t % total || total;
    var index = 0;
    while (t > pulses[index].Duration) t -= pulses[index++].Duration;
    if (interval <= 0) {
        for (c = 0; c < 4; c++) result[c] = pulses[index].Color[c];
        return result;
    }
    for (c = 0; c < 4; c++) result[c] = 0;
    // Integrate whole cycles in constant time, including large time steps.
    var cycles = Math.floor(interval / total);
    var remaining = interval - cycles * total;
    for (i = 0; i < pulses.length; i++)
        for (c = 0; c < 4; c++)
            result[c] += cycles * pulses[i].Duration * pulses[i].Color[c] / interval;
    while (remaining > 0) {
        var amount = Math.min(remaining, pulses[index].Duration - t);
        for (c = 0; c < 4; c++) result[c] += amount * pulses[index].Color[c] / interval;
        remaining -= amount;
        t = 0;
        index = (index + 1) % pulses.length;
    }
    return result;
};

export default {
    number: number,
    vector: vector,
    sector: sector,
    blinkSequence: blinkSequence,
    sequenceGroup: sequenceGroup,
    system: system,
    sectorFactor: sectorFactor,
    pulseColor: pulseColor
};
