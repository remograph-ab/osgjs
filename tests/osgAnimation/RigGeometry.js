import { assert } from 'chai';
import 'tests/mockup/mockup';
import Geometry from 'osg/Geometry';
import BufferArray from 'osg/BufferArray';
import RigGeometry from 'osgAnimation/RigGeometry';

var createRig = function(weights) {
    var source = new Geometry();
    source.getAttributes().Vertex = new BufferArray(
        BufferArray.ARRAY_BUFFER,
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0]),
        3
    );
    var rig = new RigGeometry();
    rig.setSourceGeometry(source);
    rig.getAttributes().Weights = new BufferArray(
        BufferArray.ARRAY_BUFFER,
        new Float32Array(weights),
        4
    );
    rig.mergeChildrenData();
    return rig;
};

export default function() {
    test('RigGeometry bounding box of non-influenced vertices', function() {
        // Only the second vertex is not influenced by any bone
        var rig = createRig([1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
        var box = rig.getBoundingBox();
        assert.deepEqual(Array.from(box.getMin()), [1, 0, 0]);
        assert.deepEqual(Array.from(box.getMax()), [1, 0, 0]);
    });

    test('RigGeometry bounding box of fully skinned geometry is the bind pose', function() {
        var rig = createRig([1, 0, 0, 0, 0.5, 0.5, 0, 0, 1, 0, 0, 0]);
        var box = rig.getBoundingBox();
        assert.isTrue(box.valid());
        assert.deepEqual(Array.from(box.getMin()), [0, 0, 0]);
        assert.deepEqual(Array.from(box.getMax()), [1, 2, 0]);
    });
}
