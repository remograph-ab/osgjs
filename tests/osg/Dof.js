import { assert } from 'chai';
import 'tests/mockup/mockup';
import Dof from 'osg/Dof';
import Node from 'osg/Node';
import MatrixTransform from 'osg/MatrixTransform';
import UpdateVisitor from 'osg/UpdateVisitor';
import FrameStamp from 'osg/FrameStamp';
import cullVisitorHelper from 'osg/cullVisitorHelper';
import TransformEnums from 'osg/transformEnums';
import Input from 'osgDB/Input';
import { mat4, vec3 } from 'osg/glMatrix';

var DEG = Math.PI / 180;

var transformPoint = function(dof, point) {
    return Array.prototype.slice.call(vec3.transformMat4(vec3.create(), point, dof.getMatrix()));
};

var assertClose = function(actual, expected, message) {
    assert.equal(actual.length, expected.length, message);
    for (var i = 0; i < expected.length; i++)
        assert.approximately(actual[i], expected[i], 1e-5, message + ' [' + i + ']');
};

// A DOF with its local frame at origin, like the OpenFlight reader creates it
var createPivotDof = function(origin) {
    var dof = new Dof();
    var inversePut = mat4.fromTranslation(mat4.create(), origin);
    dof.setInversePutMatrix(inversePut);
    dof.setPutMatrix(mat4.invert(mat4.create(), inversePut));
    return dof;
};

var createUpdater = function() {
    var visitor = new UpdateVisitor();
    var stamp = new FrameStamp();
    visitor.setFrameStamp(stamp);
    return function(node, frame, time) {
        stamp.setFrameNumber(frame);
        stamp.setSimulationTime(time);
        node.accept(visitor);
    };
};

export default function() {
    test('Dof defaults to an identity transform', function() {
        var dof = new Dof();
        assertClose(dof.getMatrix(), mat4.create(), 'identity');
        assert.isFalse(dof.getAnimationOn());
        assert.equal(dof.getHPRMultOrder(), Dof.PRH);
        assert.equal(dof.getNumChildrenRequiringUpdateTraversal(), 0);
        assert.throws(function() {
            dof.setCurrentHPR([0, NaN, 0]);
        }, TypeError);
    });

    test('Dof current values are applied about the put frame', function() {
        var dof = createPivotDof([10, 20, 30]);
        dof.setCurrentHPR([30 * DEG, 0, 0]);
        var expected = [10 + Math.cos(30 * DEG), 20 + Math.sin(30 * DEG), 30];
        assertClose(transformPoint(dof, [11, 20, 30]), expected, 'heading about pivot');

        dof.setCurrentHPR([0, 90 * DEG, 0]);
        assertClose(transformPoint(dof, [10, 21, 30]), [10, 20, 31], 'pitch about x');
        dof.setCurrentHPR([0, 0, 90 * DEG]);
        assertClose(transformPoint(dof, [10, 20, 31]), [11, 20, 30], 'roll about y');

        dof.setCurrentHPR([0, 0, 0]);
        dof.setCurrentTranslate([1, 2, 3]);
        dof.setCurrentScale([2, 2, 2]);
        assertClose(transformPoint(dof, [11, 20, 30]), [13, 22, 33], 'scale then translate');

        var local = mat4.create();
        dof.computeLocalToWorldMatrix(local);
        assertClose(local, dof.getMatrix(), 'local');
        var inverse = mat4.create();
        dof.computeWorldToLocalMatrix(inverse);
        assertClose(mat4.mul(mat4.create(), dof.getMatrix(), inverse), mat4.create(), 'inverse');
    });

    test('Dof bound follows the current values', function() {
        var dof = createPivotDof([0, 0, 0]);
        var child = new Node();
        child.computeBoundingSphere = function(sphere) {
            sphere.set(vec3.fromValues(10, 0, 0), 1);
            return sphere;
        };
        dof.addChild(child);
        assertClose(dof.getBoundingSphere().center(), [10, 0, 0], 'initial bound');
        dof.setCurrentHPR([90 * DEG, 0, 0]);
        assertClose(dof.getBoundingSphere().center(), [0, 10, 0], 'rotated bound');
    });

    test('Dof rotation orders match osgSim::DOFTransform', function() {
        var hpr = [10 * DEG, 20 * DEG, 30 * DEG];
        var rotation = {
            H: mat4.fromZRotation(mat4.create(), hpr[0]),
            P: mat4.fromXRotation(mat4.create(), hpr[1]),
            R: mat4.fromYRotation(mat4.create(), hpr[2])
        };
        Dof.MULT_ORDER_NAMES.forEach(function(name, order) {
            var dof = new Dof();
            dof.setHPRMultOrder(order);
            dof.setCurrentHPR(hpr);
            // osgSim pre-multiplies in name order, e.g. PRH gives H * R * P with row vectors
            var expected = mat4.create();
            for (var i = 0; i < 3; i++) mat4.mul(expected, expected, rotation[name[i]]);
            assertClose(dof.getMatrix(), expected, name);
        });
        assert.throws(function() {
            new Dof().setHPRMultOrder(6);
        }, RangeError);
    });

    test('Dof animation starts from the current values', function() {
        var parent = new Node();
        var dof = new Dof();
        parent.addChild(dof);
        dof.setCurrentHPR([30 * DEG, 0, 0]);
        dof.setIncrementHPR([90 * DEG, 0, 0]);
        dof.setAnimationOn(true);
        assert.equal(parent.getNumChildrenRequiringUpdateTraversal(), 1, 'parent updated');

        var update = createUpdater();
        update(parent, 1, 1000);
        assert.approximately(dof.getCurrentHPR()[0], 30 * DEG, 1e-9, 'no initial jump');
        update(parent, 1, 1001);
        assert.approximately(dof.getCurrentHPR()[0], 30 * DEG, 1e-9, 'once per frame');
        update(parent, 2, 1000.5);
        assert.approximately(dof.getCurrentHPR()[0], 75 * DEG, 1e-9, 'incremented');
        update(parent, 3, 1002.5);
        assert.approximately(dof.getCurrentHPR()[0], -105 * DEG, 1e-9, 'unlimited wrapped');

        dof.setAnimationOn(false);
        assert.equal(parent.getNumChildrenRequiringUpdateTraversal(), 0, 'parent released');
        update(parent, 4, 1010);
        assert.approximately(dof.getCurrentHPR()[0], -105 * DEG, 1e-9, 'stopped');
    });

    test('Dof limited animation bounces between min and max', function() {
        var dof = new Dof();
        dof.setMinTranslate([0, 0, 0]);
        dof.setMaxTranslate([0, 0, 2]);
        dof.setIncrementTranslate([0, 0, 1]);
        dof.setLimitationFlags(Dof.TRANSLATION_Z_LIMIT_BIT);
        dof.setAnimationOn(true);
        dof.animate(1.5);
        assert.equal(dof.getCurrentTranslate()[2], 1.5);
        dof.animate(1);
        assert.equal(dof.getCurrentTranslate()[2], 2, 'clamped at max');
        dof.animate(0.5);
        assert.equal(dof.getCurrentTranslate()[2], 1.5, 'reversed');
        assert.equal(dof.getIncreasingFlags() & Dof.TRANSLATE_INCREASING_BITS[2], 0);

        var fixed = new Dof();
        fixed.setCurrentHPR([0, 0, 1]);
        fixed.setIncrementHPR([0, 0, 1]);
        fixed.setMinHPR([0, 0, 0]);
        fixed.setMaxHPR([0, 0, 0]);
        fixed.setLimitationFlags(Dof.ROTATION_ROLL_LIMIT_BIT);
        fixed.setAnimationOn(true);
        fixed.animate(1);
        assert.equal(fixed.getCurrentHPR()[2], 1, 'min == max keeps the value');
    });

    test('Dof is culled like a MatrixTransform', function() {
        assert.equal(
            cullVisitorHelper.getApplyFunction(Dof.nodeTypeID),
            cullVisitorHelper.getApplyFunction(MatrixTransform.nodeTypeID)
        );
    });

    test('Dof .osgjs reading', function() {
        var inversePut = Array.prototype.slice.call(mat4.fromTranslation(mat4.create(), [5, 0, 0]));
        var put = Array.prototype.slice.call(mat4.fromTranslation(mat4.create(), [-5, 0, 0]));
        var input = new Input();
        return input
            .setJSON({
                'osg.Dof': {
                    Name: 'windturbine_rotor_dof_1',
                    CurrentHPR: [0, 0, 30 * DEG],
                    IncrementHPR: [0, 0, 1],
                    MinHPR: [0, 0, 0],
                    MaxHPR: [0, 0, 6.28],
                    MinScale: [1, 1, 1],
                    MaxScale: [1, 1, 1],
                    CurrentScale: [1, 1, 1],
                    PutMatrix: put,
                    InversePutMatrix: inversePut,
                    LimitationFlags: Dof.ROTATION_ROLL_LIMIT_BIT,
                    HPRMultOrder: 'HRP',
                    AnimationOn: true,
                    ReferenceFrame: 'ABSOLUTE_RF',
                    Children: [{ 'osg.Node': { Name: 'blades' } }]
                }
            })
            .readObject()
            .then(function(dof) {
                assert.instanceOf(dof, Dof);
                assert.equal(dof.getName(), 'windturbine_rotor_dof_1');
                assert.equal(dof.getChildren()[0].getName(), 'blades');
                assert.equal(dof.getHPRMultOrder(), Dof.HRP);
                assert.equal(dof.getLimitationFlags(), Dof.ROTATION_ROLL_LIMIT_BIT);
                assert.isTrue(dof.getAnimationOn());
                assert.equal(dof.getReferenceFrame(), TransformEnums.ABSOLUTE_RF);
                assertClose(
                    transformPoint(dof, [5, 0, 1]),
                    [5 + Math.sin(30 * DEG), 0, Math.cos(30 * DEG)],
                    'current roll about the put origin'
                );
                return new Input()
                    .setJSON({ 'osg.Dof': { CurrentHPR: [0, 1] } })
                    .readObject()
                    .then(
                        function() {
                            assert.fail('invalid Dof accepted');
                        },
                        function() {}
                    );
            });
    });
}
