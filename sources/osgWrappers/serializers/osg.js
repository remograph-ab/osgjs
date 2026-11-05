import P from 'bluebird';
import utils from 'osg/utils';
import Sequence from 'osg/Sequence';
import LightPoint from 'osg/LightPoint';
import lightPointUtils from 'osg/lightPointUtils';
import TransformEnums from 'osg/transformEnums';

var rejectObject = utils.rejectObject;

var osgWrapper = {};

osgWrapper.Object = function(input, obj) {
    var jsonObj = input.getJSON();

    if (jsonObj.Name) obj.setName(jsonObj.Name);

    if (jsonObj.UserDataContainer) {
        var userdata = input.setJSON(jsonObj.UserDataContainer).readUserDataContainer();
        if (userdata !== undefined) {
            obj.setUserData(userdata);
        }
    }

    return obj;
};
/* jshint newcap: false */
osgWrapper.Node = function(input, node) {
    var jsonObj = input.getJSON();

    osgWrapper.Object(input, node);

    var promiseArray = [];

    if (jsonObj.UpdateCallbacks) {
        var cbAddCallback = node.addUpdateCallback.bind(node);
        for (var j = 0, l = jsonObj.UpdateCallbacks.length; j < l; j++) {
            var promise = input.setJSON(jsonObj.UpdateCallbacks[j]).readObject();
            promiseArray.push(promise);
            promise.then(cbAddCallback);
        }
    }

    if (jsonObj.StateSet) {
        var pp = input.setJSON(jsonObj.StateSet).readObject();
        promiseArray.push(pp);
        pp.then(node.setStateSet.bind(node));
    }

    var queue = [];
    // For each url, create a function call and add it to the queue
    if (jsonObj.Children) {
        for (var i = 0, k = jsonObj.Children.length; i < k; i++) {
            queue.push(input.setJSON(jsonObj.Children[i]).readObject());
        }
    }
    // Resolve first updateCallbacks and stateset.
    return P.all(promiseArray).then(function() {
        // Need to wait until the stateset and the all the callbacks are resolved
        return P.all(queue).then(function(queueNodes) {
            // All the results from P.all are on the argument as an array
            // Now insert children in the right order
            var len = queueNodes.length;
            for (var n = 0; n < len; n++) node.addChild(queueNodes[n]);
            return node;
        });
    });
};

osgWrapper.StateSet = function(input, stateSet) {
    var jsonObj = input.getJSON();

    osgWrapper.Object(input, stateSet);

    if (jsonObj.RenderingHint !== undefined) {
        stateSet.setRenderingHint(jsonObj.RenderingHint);
    }

    var promiseArray = [];

    var createAttribute = function(jsonAttribute) {
        var promise = input.setJSON(jsonAttribute).readObject();
        if (
            promise.isRejected() // sometimes we have some empty objects
        )
            return;
        promiseArray.push(promise);
        promise.then(stateSet.setAttributeAndModes.bind(stateSet));
    };

    if (jsonObj.AttributeList !== undefined) {
        for (var i = 0, l = jsonObj.AttributeList.length; i < l; i++) {
            createAttribute(jsonObj.AttributeList[i]);
        }
    }

    var createTextureAttribute = function(unit, textureAttribute) {
        var promise = input.setJSON(textureAttribute).readObject();
        if (
            promise.isRejected() // sometimes we have some empty objects
        )
            return;
        promiseArray.push(promise);
        promise.then(stateSet.setTextureAttributeAndModes.bind(stateSet, unit));
    };

    if (jsonObj.TextureAttributeList) {
        var textures = jsonObj.TextureAttributeList;
        for (var t = 0, lt = textures.length; t < lt; t++) {
            var textureAttributes = textures[t];
            for (var a = 0, al = textureAttributes.length; a < al; a++) {
                createTextureAttribute(t, textureAttributes[a]);
            }
        }
    }

    return P.all(promiseArray).then(function() {
        return stateSet;
    });
};

osgWrapper.Material = function(input, material) {
    var jsonObj = input.getJSON();
    if (
        !jsonObj.Diffuse ||
        !jsonObj.Emission ||
        !jsonObj.Specular ||
        jsonObj.Shininess === undefined
    ) {
        return rejectObject('Material', jsonObj);
    }

    osgWrapper.Object(input, material);

    material.setAmbient(jsonObj.Ambient);
    material.setDiffuse(jsonObj.Diffuse);
    material.setEmission(jsonObj.Emission);
    material.setSpecular(jsonObj.Specular);
    material.setShininess(jsonObj.Shininess);
    return P.resolve(material);
};

osgWrapper.BlendFunc = function(input, blend) {
    var jsonObj = input.getJSON();
    if (
        !jsonObj.SourceRGB ||
        !jsonObj.SourceAlpha ||
        !jsonObj.DestinationRGB ||
        !jsonObj.DestinationAlpha
    ) {
        return rejectObject('BlendFunc', jsonObj);
    }

    osgWrapper.Object(input, blend);

    blend.setSourceRGB(jsonObj.SourceRGB);
    blend.setSourceAlpha(jsonObj.SourceAlpha);
    blend.setDestinationRGB(jsonObj.DestinationRGB);
    blend.setDestinationAlpha(jsonObj.DestinationAlpha);
    return P.resolve(blend);
};

osgWrapper.CullFace = function(input, attr) {
    var jsonObj = input.getJSON();
    if (jsonObj.Mode === undefined) return rejectObject('CullFace', jsonObj);

    osgWrapper.Object(input, attr);
    attr.setMode(jsonObj.Mode);
    return P.resolve(attr);
};

osgWrapper.BlendColor = function(input, attr) {
    var jsonObj = input.getJSON();
    if (!jsonObj.ConstantColor) return rejectObject('BlendColor', jsonObj);

    osgWrapper.Object(input, attr);
    attr.setConstantColor(jsonObj.ConstantColor);
    return P.resolve(attr);
};

osgWrapper.Light = function(input, light) {
    var jsonObj = input.getJSON();

    if (
        !jsonObj.Ambient ||
        !jsonObj.Diffuse ||
        !jsonObj.Direction ||
        !jsonObj.Position ||
        !jsonObj.Specular ||
        jsonObj.LightNum === undefined ||
        jsonObj.SpotCutoff === undefined ||
        jsonObj.LinearAttenuation === undefined ||
        jsonObj.ConstantAttenuation === undefined ||
        jsonObj.QuadraticAttenuation === undefined
    ) {
        return rejectObject('Light', jsonObj);
    }

    osgWrapper.Object(input, light);
    light.setAmbient(jsonObj.Ambient);
    light.setConstantAttenuation(jsonObj.ConstantAttenuation);
    light.setDiffuse(jsonObj.Diffuse);
    light.setDirection(jsonObj.Direction);
    light.setLightNumber(jsonObj.LightNum);
    light.setLinearAttenuation(jsonObj.LinearAttenuation);
    light.setPosition(jsonObj.Position);
    light.setQuadraticAttenuation(jsonObj.QuadraticAttenuation);
    light.setSpecular(jsonObj.Specular);
    light.setSpotCutoff(jsonObj.SpotCutoff);
    light.setSpotBlend(0.01);
    if (jsonObj.SpotExponent !== undefined) {
        light.setSpotBlend(jsonObj.SpotExponent / 128.0);
    }
    return P.resolve(light);
};

osgWrapper.Texture = function(input, texture) {
    var jsonObj = input.getJSON();

    osgWrapper.Object(input, texture);

    if (jsonObj.MinFilter) texture.setMinFilter(jsonObj.MinFilter);
    if (jsonObj.MagFilter) texture.setMagFilter(jsonObj.MagFilter);
    if (jsonObj.WrapT) texture.setWrapT(jsonObj.WrapT);
    if (jsonObj.WrapS) texture.setWrapS(jsonObj.WrapS);
    if (jsonObj.MaxAnisotropy) texture.setMaxAnisotropy(jsonObj.MaxAnisotropy);

    // no file return dummy texture
    var file = jsonObj.File;
    if (file === undefined) {
        file = 'no-image-provided';
    }

    return input.readImageURL(file).then(function(img) {
        texture.setImage(img);
        return texture;
    });
};

osgWrapper.Projection = function(input, node) {
    var jsonObj = input.getJSON();
    if (!jsonObj.Matrix) return rejectObject('Projection', jsonObj);

    var promise = osgWrapper.Node(input, node);
    node.setMatrix(jsonObj.Matrix);
    return promise;
};

osgWrapper.MatrixTransform = function(input, node) {
    var jsonObj = input.getJSON();
    if (!jsonObj.Matrix) return rejectObject('MatrixTransform', jsonObj);

    var promise = osgWrapper.Node(input, node);
    node.setMatrix(jsonObj.Matrix);
    return promise;
};

osgWrapper.LightSource = function(input, node) {
    var jsonObj = input.getJSON();
    if (!jsonObj.Light) return rejectObject('LightSource', jsonObj);

    var promise = osgWrapper.Node(input, node);
    return P.all([input.setJSON(jsonObj.Light).readObject(), promise]).then(function(args) {
        var light = args[0];
        //var lightsource = args[ 1 ];
        node.setLight(light);
        if (jsonObj.ReferenceFrame === 'ABSOLUTE_RF') {
            node.setReferenceFrame(TransformEnums.ABSOLUTE_RF);
        }
        return node;
    });
};

// not robust, but we probably don't want to complexify the function for now
osgWrapper.functionSortAttributes = function(a, b) {
    if (a.indexOf('TexCoord') !== -1 && b.indexOf('TexCoord') !== -1) {
        return parseInt(a.substr(8), 10) - parseInt(b.substr(8), 10);
    }

    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
};

osgWrapper.Geometry = function(input, node) {
    var jsonObj = input.getJSON();
    if (!jsonObj.VertexAttributeList) return rejectObject('Geometry', jsonObj);

    jsonObj.PrimitiveSetList = jsonObj.PrimitiveSetList || [];

    var arraysPromise = [];
    arraysPromise.push(osgWrapper.Node(input, node));

    var prims = node.getPrimitives();
    var cbAddPrimitives = prims.push.bind(prims);
    var i = 0;
    var l = jsonObj.PrimitiveSetList.length;
    for (i = 0; i < l; i++) {
        var promisePrimitive = input.setJSON(jsonObj.PrimitiveSetList[i]).readPrimitiveSet();
        arraysPromise.push(promisePrimitive);
        promisePrimitive.then(cbAddPrimitives);
    }

    var cbSetBuffer = function(name, buffer) {
        this.getVertexAttributeList()[name] = buffer;
    };

    var vList = jsonObj.VertexAttributeList;
    var keys = window.Object.keys(vList);

    // TexCoord10 should be sorted after TexCoord5 (in case of referenced attributes)
    // alternative is to resolve the referenced keys (2 passes method for example)
    keys.sort(osgWrapper.functionSortAttributes);

    l = keys.length;
    for (i = 0; i < l; i++) {
        var name = keys[i];
        var promiseBuffer = input.setJSON(vList[name]).readBufferArray();
        arraysPromise.push(promiseBuffer);
        promiseBuffer.then(cbSetBuffer.bind(node, name));
    }

    return P.all(arraysPromise).then(function() {
        return node;
    });
};

function parseLodParameters(jsonObj, lod) {
    // Parse center Mode
    if (jsonObj.CenterMode === 'USE_BOUNDING_SPHERE_CENTER') lod.setCenterMode(0);
    else if (jsonObj.CenterMode === 'UNION_OF_BOUNDING_SPHERE_AND_USER_DEFINED')
        lod.setCenterMode(2);

    // Parse center and radius
    lod.setCenter([jsonObj.UserCenter[0], jsonObj.UserCenter[1], jsonObj.UserCenter[2]]);
    lod.setRadius(jsonObj.UserCenter[3]);

    // Parse RangeMode
    if (jsonObj.RangeMode === 'PIXEL_SIZE_ON_SCREEN') lod.setRangeMode(1);
}

osgWrapper.Lod = function(input, lod) {
    var jsonObj = input.getJSON();

    osgWrapper.Object(input, lod);

    parseLodParameters(jsonObj, lod);

    var queue = [];
    // For each url, create a function call and add it to the queue
    if (jsonObj.Children) {
        for (var i = 0, k = jsonObj.Children.length; i < k; i++) {
            queue.push(input.setJSON(jsonObj.Children[i]).readObject());
        }
    }
    
    var o = jsonObj.RangeList;
    var str;
    
    // Need to wait until the stateset and the all the callbacks are resolved
    return P.all(queue).then(function(queueNodes) {
        // All the results from P.all are on the argument as an array
        // Now insert children in the right order
        var len = queueNodes.length;
        for (var n = 0; n < len; n++) {
            str = 'Range ' + n;
            var v = o[str];
            lod.addChild(queueNodes[n], v[0], v[1]);
        }
        return lod;
    });
};

var isNumber = function(value) {
    return typeof value === 'number' && isFinite(value);
};

var lightPointDataKinds = new WeakMap();
var readLightPointData = function(input, json, kind) {
    if (!json || typeof json !== 'object' || Array.isArray(json))
        throw new TypeError('Invalid light-point ' + kind);
    var id = json.UniqueID;
    var map = input.getIdentifierMap();
    if (id !== undefined) {
        if (!Number.isInteger(id) || id < 0)
            throw new RangeError('Invalid light-point UniqueID');
        if (map[id] !== undefined) {
            if (lightPointDataKinds.get(map[id]) !== kind)
                throw new TypeError('Light-point UniqueID has an incompatible type');
            return map[id];
        }
        if (Object.keys(json).length === 1)
            throw new RangeError('Unresolved light-point ' + kind + ' reference ' + id);
    }
    var value = lightPointUtils[kind](json);
    lightPointDataKinds.set(value, kind);
    if (id !== undefined) map[id] = value;
    if (kind === 'blinkSequence' && json.SequenceGroup !== undefined)
        value.SequenceGroup = readLightPointData(input, json.SequenceGroup, 'sequenceGroup');
    return value;
};

var readLightPoint = function(input, json, point) {
    if (!json || typeof json !== 'object' || Array.isArray(json))
        throw new TypeError('Invalid LightPoint record');
    if (json.On !== undefined) point.setOn(json.On);
    if (json.Position !== undefined) point.setPosition(json.Position);
    if (json.Color !== undefined) point.setColor(json.Color);
    if (json.Intensity !== undefined) point.setIntensity(json.Intensity);
    if (json.Radius !== undefined) point.setRadius(json.Radius);
    if (json.BlendingMode !== undefined) {
        if (json.BlendingMode !== 'ADDITIVE' && json.BlendingMode !== 'BLENDED')
            throw new RangeError('Invalid LightPoint blending mode');
        point.setBlendingMode(LightPoint[json.BlendingMode]);
    }
    if (json.Sector !== undefined) point.setSector(json.Sector);
    if (json.BlinkSequence !== undefined)
        point._blinkSequence = readLightPointData(input, json.BlinkSequence, 'blinkSequence');
    return point;
};

osgWrapper.LightPoint = function(input, point) {
    var json = input.getJSON();
    return P.try(function() {
        osgWrapper.Object(input, point);
        return readLightPoint(input, json, point);
    });
};

osgWrapper.LightPointNode = function(input, node) {
    var json = input.getJSON();
    return P.try(function() {
        if (json.LightPoints !== undefined && !Array.isArray(json.LightPoints))
            throw new TypeError('Invalid LightPointNode LightPoints array');
        if (json.MaxPixelSize !== undefined) node.setMaxPixelSize(json.MaxPixelSize);
        if (json.MinPixelSize !== undefined) node.setMinPixelSize(json.MinPixelSize);
        if (json.MaxVisibleDistance2 !== undefined)
            node.setMaxVisibleDistance2(json.MaxVisibleDistance2);
        if (json.PointSprite !== undefined) node.setPointSprite(json.PointSprite);
        if (json.LightPointSystem !== undefined)
            node._lightPointSystem = readLightPointData(
                input,
                json.LightPointSystem,
                'system'
            );
        var points = json.LightPoints || [];
        for (var i = 0; i < points.length; i++)
            node.addLightPoint(readLightPoint(input, points[i], new LightPoint()));
        return osgWrapper.Node(input.setJSON(json), node);
    });
};

osgWrapper.Sequence = function(input, sequence) {
    var jsonObj = input.getJSON();
    var timeList = jsonObj.TimeList || [];
    var numberFields = [
        'Begin',
        'End',
        'Speed',
        'NumRepeats',
        'DefaultTime',
        'LastFrameTime',
        'Value'
    ];
    var invalid =
        !Array.isArray(timeList) ||
        timeList.some(function(time) {
            return !isNumber(time) || time < 0;
        }) ||
        numberFields.some(function(field) {
            return jsonObj[field] !== undefined && !isNumber(jsonObj[field]);
        });
    if (invalid) return rejectObject('Sequence', jsonObj);

    var valueOr = function(value, defaultValue) {
        return value === undefined ? defaultValue : value;
    };

    // Frame times must be set before osgWrapper.Node adds the children,
    // otherwise each child would get the default time.
    sequence.setTimeList(timeList);
    sequence.setDefaultTime(valueOr(jsonObj.DefaultTime, 1));
    sequence.setInterval(
        jsonObj.LoopMode === 'SWING' ? Sequence.SWING : Sequence.LOOP,
        valueOr(jsonObj.Begin, 0),
        valueOr(jsonObj.End, -1)
    );
    sequence.setDuration(valueOr(jsonObj.Speed, 0), valueOr(jsonObj.NumRepeats, -1));
    sequence.setLastFrameTime(valueOr(jsonObj.LastFrameTime, 0));
    sequence.setSync(jsonObj.Sync === true);
    sequence.setClearOnStop(jsonObj.ClearOnStop === true);

    var mode = jsonObj.Mode;
    if (mode === 'START' || mode === 'RESUME') {
        sequence.setMode(Sequence.START);
    } else if (mode === 'PAUSE') {
        sequence.setMode(Sequence.START);
        sequence.setValue(valueOr(jsonObj.Value, -1));
        sequence.setMode(Sequence.PAUSE);
    } else {
        sequence.setMode(Sequence.STOP);
        sequence.setValue(valueOr(jsonObj.Value, -1));
    }

    return osgWrapper.Node(input, sequence);
};

osgWrapper.Switch = function(input, sw) {
    var jsonObj = input.getJSON();
    var valueList = jsonObj.ValueList;
    if (valueList !== undefined && !Array.isArray(valueList)) return rejectObject('Switch', jsonObj);

    return osgWrapper.Node(input, sw).then(function() {
        // Children were added enabled by default. Like osg::Switch, children not covered by
        // the value list are disabled.
        if (valueList) {
            for (var i = 0, l = sw.getChildren().length; i < l; i++) {
                sw.setValue(i, i < valueList.length && valueList[i] === true);
            }
        }
        return sw;
    });
};

osgWrapper.MultiSwitch = function(input, multiSwitch) {
    var jsonObj = input.getJSON();
    var switchSets = jsonObj.SwitchSetList || [];
    var names = jsonObj.SwitchSetNameList || [];
    var invalid =
        !Array.isArray(switchSets) ||
        !Array.isArray(names) ||
        switchSets.some(function(values) {
            return !Array.isArray(values);
        }) ||
        (jsonObj.ActiveSwitchSet !== undefined && !isNumber(jsonObj.ActiveSwitchSet));
    if (invalid) return rejectObject('MultiSwitch', jsonObj);

    multiSwitch.setNewChildDefaultValue(jsonObj.NewChildDefaultValue !== false);
    multiSwitch.setActiveSwitchSet(jsonObj.ActiveSwitchSet || 0);
    // Values are set before osgWrapper.Node adds the children, which keeps them as is
    for (var i = 0; i < switchSets.length; i++) {
        multiSwitch.setValueList(
            i,
            switchSets[i].map(function(value) {
                return value === true;
            })
        );
    }
    for (var j = 0; j < names.length && j < switchSets.length; j++) {
        if (typeof names[j] === 'string') multiSwitch.setValueName(j, names[j]);
    }

    return osgWrapper.Node(input, multiSwitch);
};

osgWrapper.PagedLOD = function(input, plod) {
    var jsonObj = input.getJSON();

    osgWrapper.Object(input, plod);
    
    parseLodParameters(jsonObj, plod);

    // Parse Ranges
    var o = jsonObj.RangeList;
    var str;
    for (var i = 0; i < window.Object.keys(o).length; i++) {
        str = 'Range ' + i;
        var v = o[str];
        plod.setRange(i, v[0], v[1]);
    }

    // Parse Files
    var o = jsonObj.RangeDataList;
    var str;
    for (var i = 0; i < window.Object.keys(o).length; i++) {
        str = 'File ' + i;
        plod.setFileName(i, o[str]);
    }
    // Set database path from options
    // TODO: Check also if we have a path from json
    plod.setDatabasePath(input.getDatabasePath());

    var queue = [];
    // For each url, create a function call and add it to the queue
    if (jsonObj.Children) {
        for (var j = 0, k = jsonObj.Children.length; j < k; j++) {
            queue.push(input.setJSON(jsonObj.Children[j]).readObject());
        }
    }

    return P.all(queue).then(function(queueNodes) {
        // All the results from P.all are on the argument as an array
        var len = queueNodes.length;
        for (var i = 0; i < len; i++) plod.addChildNode(queueNodes[i]);
        return plod;
    });
};
export default osgWrapper;
