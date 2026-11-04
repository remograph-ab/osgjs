import { assert } from 'chai';
import mockup from 'tests/mockup/mockup';
import osg from 'osg/osg';
import CullVisitor from 'osg/CullVisitor';
import FrameStamp from 'osg/FrameStamp';
import Node from 'osg/Node';
import NodeVisitor from 'osg/NodeVisitor';
import Sequence from 'osg/Sequence';
import UpdateVisitor from 'osg/UpdateVisitor';

var Input;
if (mockup.isNodeContext()) {
    Input = require('tests/mockup/InputMockup').default;
} else {
    Input = require('osgDB/Input').default;
}

var makeSequence = function(count) {
    var sequence = new Sequence();
    for (var i = 0; i < count; i++) sequence.addChild(new Node(), 1);
    sequence.setDuration(1);
    sequence.setMode(Sequence.START);
    return sequence;
};

var makeClock = function(root) {
    var visitor = new UpdateVisitor();
    var stamp = new FrameStamp();
    visitor.setFrameStamp(stamp);
    return function(time) {
        stamp.setSimulationTime(time);
        root.accept(visitor);
    };
};

export default function() {
    test('Sequence public API and child bookkeeping', function() {
        var sequence = new Sequence();
        var parent = new Node();
        var first = new Node();
        var second = new Node();
        parent.addChild(sequence);
        assert.strictEqual(parent.getNumChildrenRequiringUpdateTraversal(), 1);
        assert.strictEqual(osg.Sequence, Sequence);
        assert.strictEqual(
            CullVisitor.getApplyFunction(Sequence.nodeTypeID),
            CullVisitor.getApplyFunction(Node.nodeTypeID)
        );

        sequence.setDefaultTime(2);
        assert.isTrue(sequence.addChild(first));
        assert.isFalse(sequence.addChild(first, 9));
        assert.isTrue(sequence.insertChild(0, second, 3));
        assert.deepEqual(sequence.getChildren(), [second, first]);
        assert.deepEqual(sequence.getTimeList(), [3, 2]);
        sequence.setTime(1, -3);
        sequence.setTime(3, 4);
        assert.deepEqual(sequence.getTimeList(), [3, 0, 4, 4]);
        assert.strictEqual(sequence.getTime(5), -1);
        assert.throws(function() {
            sequence.setSpeed(NaN);
        }, RangeError);
        assert.isTrue(sequence.removeChild(first));
        assert.isFalse(sequence.removeChild(first));
        assert.deepEqual(sequence.getTimeList(), [3, 4, 4]);
        sequence.removeChildren();
        assert.strictEqual(sequence.getNumChildren(), 0);
        assert.deepEqual(sequence.getTimeList(), [4, 4]);
    });

    test('Sequence updates under a parent and selects active children', function() {
        var root = new Node();
        var sequence = makeSequence(3);
        root.addChild(sequence);
        var tick = makeClock(root);
        var active = new NodeVisitor(NodeVisitor.TRAVERSE_ACTIVE_CHILDREN);
        var seen = [];
        active.apply = function(node) {
            seen.push(node);
            this.traverse(node);
        };
        tick(10);
        assert.strictEqual(sequence.getValue(), 0);
        sequence.accept(active);
        assert.deepEqual(seen, [sequence, sequence.getChild(0)]);
        tick(11);
        assert.strictEqual(sequence.getValue(), 0);
        tick(11.1);
        assert.strictEqual(sequence.getValue(), 1);
        tick(12.1);
        assert.strictEqual(sequence.getValue(), 2);
        tick(13.1);
        assert.strictEqual(sequence.getValue(), 0);
        sequence.setMode(Sequence.STOP);
        sequence.setClearOnStop(true);
        seen.length = 0;
        sequence.accept(active);
        assert.deepEqual(seen, [sequence]);
    });

    test('Sequence reverse interval, swing, pause and restart', function() {
        var sequence = makeSequence(3);
        sequence.setInterval(Sequence.SWING, 2, 0);
        sequence.setMode(Sequence.START);
        var tick = makeClock(sequence);
        tick(0);
        assert.strictEqual(sequence.getValue(), 2);
        tick(1.1);
        assert.strictEqual(sequence.getValue(), 1);
        tick(2.1);
        assert.strictEqual(sequence.getValue(), 0);
        tick(3.1);
        assert.strictEqual(sequence.getValue(), 1);
        sequence.setMode(Sequence.PAUSE);
        tick(3.2);
        assert.strictEqual(sequence.getValue(), 1);
        sequence.setMode(Sequence.RESUME);
        tick(4.1);
        assert.strictEqual(sequence.getValue(), 2);
        sequence.setMode(Sequence.START);
        tick(5);
        assert.strictEqual(sequence.getValue(), 2);
    });

    test('Sequence sync catches up and zero-duration frames do not hang', function() {
        var sequence = makeSequence(3);
        sequence.setSync(true);
        var tick = makeClock(sequence);
        tick(0);
        tick(5.2);
        assert.strictEqual(sequence.getValue(), 2);
        sequence.setInterval(Sequence.SWING, 0, 2);
        sequence.setMode(Sequence.START);
        tick(10);
        tick(13.2);
        assert.strictEqual(sequence.getValue(), 1);
        tick(14.2);
        assert.strictEqual(sequence.getValue(), 0);
        sequence.setTimeList([0, 0, 0]);
        sequence.setMode(Sequence.START);
        tick(20);
        tick(21);
        assert.strictEqual(sequence.getValue(), 0);
    });

    test('Sequence restores the special last frame time on restart', function() {
        var sequence = makeSequence(3);
        sequence.setDuration(1, 1);
        sequence.setLastFrameTime(3);
        var tick = makeClock(sequence);
        tick(0);
        assert.strictEqual(sequence.getTime(2), 3);
        tick(1.1);
        tick(2.1);
        assert.strictEqual(sequence.getValue(), 2);
        tick(3);
        assert.strictEqual(sequence.getMode(), Sequence.STOP);
        sequence.setMode(Sequence.START);
        assert.strictEqual(sequence.getTime(2), 1);
    });

    test('Sequence sync accounts for endpoint crossings and frame edits', function() {
        var sequence = makeSequence(3);
        sequence.setDuration(1, 1);
        sequence.setSync(true);
        var tick = makeClock(sequence);
        tick(0);
        tick(2.2);
        assert.strictEqual(sequence.getValue(), 2);
        assert.strictEqual(sequence.getMode(), Sequence.STOP);

        sequence.setDuration(1, 1);
        sequence.setLastFrameTime(3);
        sequence.setMode(Sequence.START);
        tick(10);
        sequence.removeChild(sequence.getChild(0));
        sequence.setMode(Sequence.START);
        assert.deepEqual(sequence.getTimeList(), [1, 1]);
        sequence.setLastFrameTime(0);
        sequence.setDuration(0);
        tick(20);
        tick(21);
        assert.strictEqual(sequence.getValue(), 0);
    });

    test('Sequence cull traversal visits only the selected child', function() {
        var canvas = mockup.createCanvas();
        var viewer = new mockup.Viewer(canvas);
        viewer.setupManipulator();
        viewer.init();
        viewer.frame();
        var cull = viewer
            .getCamera()
            .getRenderer()
            .getCullVisitor();
        var sequence = makeSequence(2);
        var seen = [];
        sequence.getChild(0).setCullCallback({
            cull: function() {
                seen.push(0);
                return true;
            }
        });
        sequence.getChild(1).setCullCallback({
            cull: function() {
                seen.push(1);
                return true;
            }
        });
        sequence.setValue(1);
        sequence.accept(cull);
        assert.deepEqual(seen, [1]);
        mockup.removeCanvas(canvas);
        viewer.getInputManager().cleanup();
    });

    var sequenceJSON = function(fields) {
        var json = {
            UniqueID: 7,
            Name: 'seq',
            TimeList: [0.5, 2, 1],
            LoopMode: 'SWING',
            Begin: 0,
            End: 2,
            Speed: 1,
            NumRepeats: 3,
            DefaultTime: 4,
            LastFrameTime: 0.25,
            Mode: 'START',
            Value: -1,
            Sync: true,
            ClearOnStop: true,
            Children: [
                { 'osg.Node': { Name: 'a' } },
                { 'osg.Node': { Name: 'b' } },
                { 'osg.Node': { Name: 'c' } }
            ]
        };
        for (var key in fields) json[key] = fields[key];
        return { 'osg.Sequence': json };
    };

    test('Sequence is read from osgjs JSON', function() {
        return new Input()
            .setJSON(sequenceJSON())
            .readObject()
            .then(function(sequence) {
                assert.instanceOf(sequence, Sequence);
                assert.strictEqual(sequence.getName(), 'seq');
                assert.deepEqual(sequence.getTimeList(), [0.5, 2, 1]);
                assert.deepEqual(
                    sequence.getChildren().map(function(child) {
                        return child.getName();
                    }),
                    ['a', 'b', 'c']
                );
                assert.deepEqual(sequence.getInterval(), [Sequence.SWING, 0, 2]);
                assert.deepEqual(sequence.getDuration(), [1, 3]);
                assert.strictEqual(sequence.getDefaultTime(), 4);
                assert.strictEqual(sequence.getLastFrameTime(), 0.25);
                assert.strictEqual(sequence.getMode(), Sequence.START);
                assert.isTrue(sequence.getSync());
                assert.isTrue(sequence.getClearOnStop());

                var tick = makeClock(sequence);
                tick(0);
                assert.strictEqual(sequence.getValue(), 0);
                tick(0.6);
                assert.strictEqual(sequence.getValue(), 1);
            });
    });

    test('Sequence JSON restores stopped and paused frames', function() {
        var stopped = new Input()
            .setJSON(sequenceJSON({ Mode: 'STOP', Value: 2 }))
            .readObject()
            .then(function(sequence) {
                assert.strictEqual(sequence.getMode(), Sequence.STOP);
                assert.strictEqual(sequence.getValue(), 2);
            });
        var paused = new Input()
            .setJSON(sequenceJSON({ Mode: 'PAUSE', Value: 1, LoopMode: 'LOOP' }))
            .readObject()
            .then(function(sequence) {
                assert.strictEqual(sequence.getMode(), Sequence.PAUSE);
                assert.strictEqual(sequence.getValue(), 1);
                sequence.setMode(Sequence.RESUME);
                var tick = makeClock(sequence);
                tick(10);
                assert.strictEqual(sequence.getValue(), 1);
                tick(12.1);
                assert.strictEqual(sequence.getValue(), 2);
            });
        var invalid = new Input()
            .setJSON(sequenceJSON({ TimeList: [1, -1] }))
            .readObject()
            .then(
                function() {
                    assert.fail('invalid TimeList should be rejected');
                },
                function() {}
            );
        return Promise.all([stopped, paused, invalid]);
    });
}
