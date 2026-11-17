import { assert } from 'chai';
import 'tests/mockup/mockup';
import osg from 'osg/osg';
import osgAnimation from 'osgAnimation/osgAnimation';
import osgText from 'osgText/osgText';
import osgShadow from 'osgShadow/osgShadow';
import osgUtil from 'osgUtil/osgUtil';
import Node from 'osg/Node';
import CopyOp from 'osg/CopyOp';
import MatrixTransform from 'osg/MatrixTransform';
import Geometry from 'osg/Geometry';
import BufferArray from 'osg/BufferArray';
import DrawArrays from 'osg/DrawArrays';
import primitiveSet from 'osg/primitiveSet';
import StateSet from 'osg/StateSet';
import Switch from 'osg/Switch';
import MultiSwitch from 'osg/MultiSwitch';
import Lod from 'osg/Lod';
import PagedLOD from 'osg/PagedLOD';
import Sequence from 'osg/Sequence';
import Dof from 'osg/Dof';
import LightPoint from 'osg/LightPoint';
import LightPointNode from 'osg/LightPointNode';
import UpdateVisitor from 'osg/UpdateVisitor';
import FrameStamp from 'osg/FrameStamp';
import { mat4, vec3, quat } from 'osg/glMatrix';
import Bone from 'osgAnimation/Bone';
import Skeleton from 'osgAnimation/Skeleton';
import RigGeometry from 'osgAnimation/RigGeometry';
import UpdateBone from 'osgAnimation/UpdateBone';
import UpdateSkeleton from 'osgAnimation/UpdateSkeleton';
import StackedTranslate from 'osgAnimation/StackedTranslate';
import StackedQuaternion from 'osgAnimation/StackedQuaternion';
import BasicAnimationManager from 'osgAnimation/BasicAnimationManager';
import Channel from 'osgAnimation/channel';
import Animation from 'osgAnimation/animation';

var createGeometry = function() {
    var geometry = new Geometry();
    geometry.getAttributes().Vertex = new BufferArray(
        BufferArray.ARRAY_BUFFER,
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        3
    );
    geometry.getPrimitives().push(new DrawArrays(primitiveSet.TRIANGLES, 0, 3));
    return geometry;
};

var createUpdater = function() {
    var visitor = new UpdateVisitor();
    var stamp = new FrameStamp();
    visitor.setFrameStamp(stamp);
    var frame = 0;
    return function(node, time) {
        stamp.setFrameNumber(++frame);
        stamp.setSimulationTime(time);
        node.accept(visitor);
    };
};

var createBone = function(name, translate) {
    var bone = new Bone(name);
    var callback = new UpdateBone();
    callback.setName(name);
    callback.getStackedTransforms().push(new StackedTranslate('translate', translate));
    callback.getStackedTransforms().push(new StackedQuaternion('quaternion', quat.create()));
    callback.computeChannels();
    bone.addUpdateCallback(callback);
    // Bind pose at the initial translation
    var bind = mat4.fromTranslation(mat4.create(), translate);
    bone.setInvBindMatrixInSkeletonSpace(mat4.invert(mat4.create(), bind));
    return bone;
};

// A skeleton with a root bone at the origin and a child bone at z = 1 moved by an animation, skinning one triangle
// fully to the child bone, below a root node with the animation manager, like osgconv creates from FBX files.
var createSkinnedModel = function() {
    var root = new MatrixTransform();
    root.setName('root');
    var skeleton = new Skeleton();
    skeleton.setDefaultUpdateCallback();
    var rootBone = createBone('rootBone', [0, 0, 0]);
    var childBone = createBone('childBone', [0, 0, 1]);
    // Bone in skeleton space of the child also includes the root bone
    childBone.setInvBindMatrixInSkeletonSpace(mat4.fromTranslation(mat4.create(), [0, 0, -1]));
    skeleton.addChild(rootBone);
    rootBone.addChild(childBone);

    var source = createGeometry();
    var rig = new RigGeometry();
    rig.setName('rig');
    rig.setSourceGeometry(source);
    rig.getAttributes().Weights = new BufferArray(
        BufferArray.ARRAY_BUFFER,
        new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
        4
    );
    rig.getAttributes().Bones = new BufferArray(
        BufferArray.ARRAY_BUFFER,
        new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        4
    );
    rig.setBoneNameID({ childBone: 0 });
    rig.mergeChildrenData();
    // Vertices relative to the child bone's bind position
    source
        .getAttributes()
        .Vertex.getElements()
        .set([0, 0, 1, 1, 0, 1, 0, 1, 1]);
    skeleton.addChild(rig);
    root.addChild(skeleton);

    // Move the child bone from x = 0 to x = 10 in 1 second
    var keys = new Float32Array([0, 0, 1, 10, 0, 1]);
    var times = new Float32Array([0, 1]);
    var channel = Channel.createVec3Channel(keys, times, 'childBone', 'translate');
    var manager = new BasicAnimationManager();
    manager.init([Animation.createAnimation([channel], 'move')]);
    root.addUpdateCallback(manager);
    return root;
};

var findNode = function(root, name) {
    if (root.getName() === name) return root;
    var children = root.getChildren();
    for (var i = 0; i < children.length; i++) {
        var found = findNode(children[i], name);
        if (found) return found;
    }
    return undefined;
};

var getAnimationManager = function(node) {
    return node.getUpdateCallbackList().filter(function(callback) {
        return callback instanceof BasicAnimationManager;
    })[0];
};

export default function() {
    test('Clone is implemented by every node class', function() {
        var namespaces = {
            osg: osg,
            osgAnimation: osgAnimation,
            osgText: osgText,
            osgShadow: osgShadow,
            osgUtil: osgUtil
        };
        var checked = 0;
        Object.keys(namespaces).forEach(function(namespaceName) {
            var namespace = namespaces[namespaceName];
            Object.keys(namespace).forEach(function(name) {
                var Class = namespace[name];
                if (
                    typeof Class !== 'function' ||
                    !(Class.prototype instanceof Node || Class === Node)
                )
                    return;
                checked++;
                assert.isOk(
                    Object.prototype.hasOwnProperty.call(Class.prototype, '_copyFrom'),
                    namespaceName + '.' + name + ' must implement _copyFrom, see CopyOp'
                );
            });
        });
        assert.isAbove(checked, 20, 'node classes checked');
    });

    test('Clone copies nodes and shares geometries and state sets', function() {
        var root = new MatrixTransform();
        root.setName('root');
        root.setMatrix(mat4.fromTranslation(mat4.create(), [1, 2, 3]));
        root.setNodeMask(0x4);
        root.setStateSet(new StateSet());
        var sw = new Switch();
        var geometry = createGeometry();
        var shared = new Node();
        shared.setName('shared');
        sw.addChild(geometry, false);
        sw.addChild(shared, true);
        root.addChild(sw);
        root.addChild(shared);

        var copy = root.clone();
        assert.notStrictEqual(copy, root);
        assert.equal(copy.getName(), 'root');
        assert.equal(copy.getNodeMask(), 0x4);
        assert.strictEqual(copy.getStateSet(), root.getStateSet(), 'state set shared');
        assert.notStrictEqual(copy.getMatrix(), root.getMatrix(), 'own matrix');
        assert.deepEqual(Array.from(copy.getMatrix()), Array.from(root.getMatrix()));

        var swCopy = copy.getChild(0);
        assert.instanceOf(swCopy, Switch);
        assert.notStrictEqual(swCopy, sw);
        assert.strictEqual(swCopy.getChild(0), geometry, 'geometry shared');
        assert.isFalse(swCopy.getValue(0));
        assert.isTrue(swCopy.getValue(1));
        swCopy.setValue(0, true);
        assert.isFalse(sw.getValue(0), 'own switch values');

        var sharedCopy = copy.getChild(1);
        assert.notStrictEqual(sharedCopy, shared);
        assert.strictEqual(swCopy.getChild(1), sharedCopy, 'node with several parents copied once');
        assert.equal(sharedCopy.getParents().length, 2);
        assert.equal(shared.getParents().length, 2, 'source unchanged');
    });

    test('Clone copies geometries when not shared', function() {
        var geometry = createGeometry();
        var root = new Node();
        root.addChild(geometry);
        var copy = root.clone(new CopyOp({ shareGeometries: false }));
        var geometryCopy = copy.getChild(0);
        assert.notStrictEqual(geometryCopy, geometry);
        assert.strictEqual(
            geometryCopy.getAttributes().Vertex,
            geometry.getAttributes().Vertex,
            'buffers shared'
        );
        assert.notStrictEqual(geometryCopy.getAttributes(), geometry.getAttributes());
        assert.deepEqual(geometryCopy.getPrimitives(), geometry.getPrimitives());

        // Cloning a geometry directly always copies it
        assert.notStrictEqual(geometry.clone(), geometry);
    });

    test('Clone copies per-child data of group nodes', function() {
        var lod = new Lod();
        lod.addChild(new Node(), 0, 100);
        lod.addChild(new Node(), 100, 1000);
        lod.setCenter([1, 2, 3]);
        var lodCopy = lod.clone();
        assert.deepEqual(lodCopy._range, [[0, 100], [100, 1000]]);
        assert.notStrictEqual(lodCopy._range[0], lod._range[0]);
        assert.deepEqual(Array.from(lodCopy.getCenter()), [1, 2, 3]);

        var paged = new PagedLOD();
        paged.addChild(new Node(), 0, 100);
        paged.setFileName(1, 'far.osgjs');
        paged.setRange(1, 100, 1000);
        var pagedCopy = paged.clone();
        assert.equal(pagedCopy._perRangeDataList.length, 2);
        assert.equal(pagedCopy._perRangeDataList[1].filename, 'far.osgjs');
        assert.notStrictEqual(pagedCopy._perRangeDataList[1], paged._perRangeDataList[1]);

        var multiSwitch = new MultiSwitch();
        multiSwitch.setSwitchSetList([[true, false], [false, true]]);
        multiSwitch.addChild(new Node());
        multiSwitch.addChild(new Node());
        multiSwitch.setActiveSwitchSet(1);
        var multiCopy = multiSwitch.clone();
        assert.deepEqual(multiCopy.getSwitchSetList(), multiSwitch.getSwitchSetList());
        assert.equal(multiCopy.getActiveSwitchSet(), 1);
        multiCopy.setValue(0, 0, false);
        assert.isTrue(multiSwitch.getValue(0, 0), 'own switch sets');

        var sequence = new Sequence();
        sequence.addChild(new Node(), 0.5);
        sequence.addChild(new Node(), 0.25);
        sequence.setDuration(2, 3);
        sequence.setMode(Sequence.START);
        var sequenceCopy = sequence.clone();
        assert.deepEqual(sequenceCopy.getTimeList(), [0.5, 0.25]);
        assert.deepEqual(sequenceCopy.getDuration(), [2, 3]);
        assert.equal(sequenceCopy.getMode(), Sequence.START);
        assert.equal(sequenceCopy.getNumChildrenRequiringUpdateTraversal(), 1);

        var dof = new Dof();
        dof.setMinHPR([-1, 0, 0]);
        dof.setMaxHPR([1, 0, 0]);
        dof.setIncrementHPR([0.5, 0, 0]);
        dof.setAnimationOn(true);
        var dofCopy = dof.clone();
        assert.deepEqual(Array.from(dofCopy.getMaxHPR()), [1, 0, 0]);
        assert.isTrue(dofCopy.getAnimationOn());
        assert.equal(dofCopy.getNumChildrenRequiringUpdateTraversal(), 1);
        dofCopy.setCurrentHPR([0.5, 0, 0]);
        assert.deepEqual(Array.from(dof.getCurrentHPR()), [0, 0, 0], 'own DOF values');
    });

    test('Clone copies light points with data shared within the copy', function() {
        var node = new LightPointNode();
        var blink = { Pulses: [{ Duration: 1, Color: [1, 0, 0, 1] }] };
        var first = new LightPoint([0, 0, 0], [1, 1, 1, 1]);
        var second = new LightPoint([1, 0, 0], [1, 1, 1, 1]);
        first.setBlinkSequence(blink);
        second._blinkSequence = first.getBlinkSequence();
        node.addLightPoint(first);
        node.addLightPoint(second);
        var copy = node.clone();
        var firstCopy = copy.getLightPoint(0);
        assert.notStrictEqual(firstCopy, first);
        assert.deepEqual(firstCopy.getPosition(), [0, 0, 0]);
        assert.notStrictEqual(
            firstCopy.getBlinkSequence(),
            first.getBlinkSequence(),
            'own blink sequence'
        );
        assert.deepEqual(firstCopy.getBlinkSequence(), first.getBlinkSequence());
        assert.strictEqual(
            copy.getLightPoint(1).getBlinkSequence(),
            firstCopy.getBlinkSequence(),
            'shared within the copy'
        );
    });

    test('Clone animates skinned geometry independently', function() {
        var update = createUpdater();
        var model = createSkinnedModel();
        var copy = model.clone();

        var rig = findNode(model, 'rig');
        var rigCopy = findNode(copy, 'rig');
        var boneCopy = findNode(copy, 'childBone');
        assert.instanceOf(rigCopy, RigGeometry);
        assert.notStrictEqual(rigCopy, rig, 'rig geometry copied');
        assert.strictEqual(
            rigCopy.getAttributes().Weights,
            rig.getAttributes().Weights,
            'weights shared'
        );
        assert.strictEqual(
            rigCopy.getSourceGeometry(),
            rig.getSourceGeometry(),
            'source geometry shared'
        );
        assert.instanceOf(boneCopy, Bone);
        assert.notStrictEqual(boneCopy, findNode(model, 'childBone'), 'bone copied');
        assert.instanceOf(boneCopy.getUpdateCallback(), UpdateBone);
        assert.notStrictEqual(
            boneCopy.getUpdateCallback(),
            findNode(model, 'childBone').getUpdateCallback()
        );
        assert.instanceOf(copy.getChild(0).getUpdateCallback(), UpdateSkeleton);
        assert.equal(rigCopy.getUpdateCallbackList().length, 1, 'one rig update callback');

        var manager = getAnimationManager(model);
        var managerCopy = getAnimationManager(copy);
        assert.notStrictEqual(managerCopy, manager, 'animation manager copied');

        // Play the animation in the original only, which starts on the next update
        manager.playAnimation('move', false);
        update(model, 0);
        update(copy, 0);
        update(model, 0.5);
        update(copy, 0.5);

        assert.strictEqual(
            rigCopy.getSkeleton(),
            copy.getChild(0),
            'copy skinned by its own skeleton'
        );
        var vertex = rig.computeTransformedVertex(0, vec3.create());
        var vertexCopy = rigCopy.computeTransformedVertex(0, vec3.create());
        assert.approximately(vertex[0], 5, 1e-5, 'original animated');
        assert.approximately(vertexCopy[0], 0, 1e-5, 'copy not animated');

        // And then the copy, which is unaffected by the original
        managerCopy.playAnimation('move', false);
        update(copy, 0.75);
        update(copy, 1);
        vertexCopy = rigCopy.computeTransformedVertex(0, vec3.create());
        assert.approximately(vertexCopy[0], 2.5, 1e-5, 'copy animated from its own start');
        vertex = rig.computeTransformedVertex(0, vec3.create());
        assert.approximately(vertex[0], 5, 1e-5, 'original unchanged');
    });

    test('Clone restarts playing animations in the copy', function() {
        var update = createUpdater();
        var model = createSkinnedModel();
        var manager = getAnimationManager(model);
        manager.playAnimation('move', true);
        update(model, 0);
        update(model, 0.5);
        assert.approximately(
            findNode(model, 'rig').computeTransformedVertex(0, vec3.create())[0],
            5,
            1e-5
        );

        var copy = model.clone();
        var managerCopy = getAnimationManager(copy);
        update(copy, 0.5);
        update(copy, 0.75);
        assert.isTrue(managerCopy.isPlaying('move'));
        var vertexCopy = findNode(copy, 'rig').computeTransformedVertex(0, vec3.create());
        assert.approximately(vertexCopy[0], 2.5, 1e-5, 'copy started when first updated');
    });

    test('Clone of text and unsupported nodes', function() {
        var text = new osgText.Text('Hello');
        text.setCharacterSize(3);
        var copy = text.clone();
        assert.equal(copy.getText(), 'Hello');
        assert.equal(copy.getCharacterSize(), 3);
        assert.equal(copy.getNumChildren(), 1, 'text quad replaced, not duplicated');
        assert.notStrictEqual(copy._geometry, text._geometry);

        assert.throws(function() {
            new osgShadow.ShadowedScene().clone();
        }, /cannot be cloned/);
    });
}
