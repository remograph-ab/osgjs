import { assert } from 'chai';
import 'tests/mockup/mockup';
import Node from 'osg/Node';
import NodeVisitor from 'osg/NodeVisitor';
import MultiSwitch from 'osg/MultiSwitch';
import utils from 'osg/utils';

var collectActiveChildren = function(node) {
    var names = [];
    var Visitor = function() {
        NodeVisitor.call(this, NodeVisitor.TRAVERSE_ACTIVE_CHILDREN);
    };
    Visitor.prototype = utils.objectInherit(NodeVisitor.prototype, {
        apply: function(n) {
            if (n !== node) names.push(n.getName());
            this.traverse(n);
        }
    });
    new Visitor().apply(node);
    return names;
};

var createChild = function(name) {
    var child = new Node();
    child.setName(name);
    return child;
};

export default function() {
    test('MultiSwitch', function() {
        var multiSwitch = new MultiSwitch();
        var a = createChild('a');
        var b = createChild('b');
        var c = createChild('c');
        multiSwitch.addChild(a);
        multiSwitch.addChild(b);

        assert.equal(multiSwitch.getNumSwitchSets(), 0, 'no switch sets');
        assert.deepEqual(collectActiveChildren(multiSwitch), [], 'no switch set, nothing active');

        multiSwitch.setValueList(1, [false, true]);
        assert.equal(multiSwitch.getNumSwitchSets(), 2, 'switch set list expanded');
        assert.deepEqual(multiSwitch.getValueList(0), [true, true], 'new set uses default value');
        assert.equal(multiSwitch.getValueName(1), '', 'names expanded with sets');

        multiSwitch.setActiveSwitchSet(1);
        assert.deepEqual(collectActiveChildren(multiSwitch), ['b'], 'only active set is used');

        multiSwitch.setNewChildDefaultValue(false);
        multiSwitch.addChild(c);
        assert.deepEqual(multiSwitch.getValueList(1), [false, true, false], 'new child value');
        assert.isOk(multiSwitch.getChildValue(c, 0) === false, 'new child in every set');

        multiSwitch.setSingleChildOn(1, 2);
        assert.deepEqual(collectActiveChildren(multiSwitch), ['c'], 'single child on');

        multiSwitch.removeChild(b);
        assert.deepEqual(multiSwitch.getValueList(1), [false, true], 'values follow removal');
        assert.deepEqual(collectActiveChildren(multiSwitch), ['c'], 'still c after removal');

        var d = createChild('d');
        multiSwitch.insertChild(0, d);
        assert.isOk(multiSwitch.getChild(0) === d, 'inserted at index');
        assert.deepEqual(multiSwitch.getValueList(1), [false, false, true], 'values follow insert');

        multiSwitch.setValueName(1, 'night');
        assert.equal(multiSwitch.getValueName(1), 'night', 'switch set name');

        multiSwitch.setActiveSwitchSet(5);
        assert.deepEqual(collectActiveChildren(multiSwitch), [], 'invalid set shows nothing');

        var all = [];
        var AllVisitor = function() {
            NodeVisitor.call(this, NodeVisitor.TRAVERSE_ALL_CHILDREN);
        };
        AllVisitor.prototype = utils.objectInherit(NodeVisitor.prototype, {
            apply: function(n) {
                if (n !== multiSwitch) all.push(n.getName());
                this.traverse(n);
            }
        });
        new AllVisitor().apply(multiSwitch);
        assert.deepEqual(all, ['d', 'a', 'c'], 'all children traversal');
    });

    test('MultiSwitch setSwitchSetList keeps names in sync', function() {
        var multiSwitch = new MultiSwitch();
        multiSwitch.addChild(createChild('a'));
        multiSwitch.setValueName(2, 'night');
        multiSwitch.setValueName(0, 'day');

        var list = [[true], [false]];
        multiSwitch.setSwitchSetList(list);
        list[0][0] = false;
        assert.equal(multiSwitch.getNumSwitchSets(), 2, 'switch set count');
        assert.deepEqual(multiSwitch.getSwitchSetList(), [[true], [false]], 'values copied');
        assert.equal(multiSwitch.getValueName(0), 'day', 'existing name kept');
        assert.isUndefined(multiSwitch.getValueName(2), 'stale name dropped');

        multiSwitch.setSwitchSetList([[true], [true], [false]]);
        assert.equal(multiSwitch.getValueName(2), '', 'new set gets empty name');
        multiSwitch.setValueName(3, 'dusk');
        assert.equal(multiSwitch.getNumSwitchSets(), 4, 'later expansion still aligned');
        assert.equal(multiSwitch.getValueName(3), 'dusk', 'name lands on its set');
    });
}
