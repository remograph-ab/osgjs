import { assert } from 'chai';
import mockup from 'tests/mockup/mockup';
import BufferArray from 'osg/BufferArray';
import GLObject from 'osg/GLObject';

export default function() {
    test('BufferArray', function() {
        (function() {
            var gl = mockup.createFakeRenderer();
            gl.createBuffer = function() {
                return {};
            };

            var content = [];
            for (var i = 0, l = 3 * 50; i < l; i++) {
                content.push(i);
            }
            var b = new BufferArray(BufferArray.ARRAY_BUFFER, content, 3);
            b.bind(gl);
            assert.isOk(b._buffer !== undefined, 'Check we created gl buffer');
            b.releaseGLObjects();
            assert.isOk(b._buffer === undefined, 'Check we released gl buffer');

            assert.equal(b.getType(), 0x1406, 'Check the type set is float 32');
            assert.equal(b.getItemSize(), 3, 'Check item size is 3');
        })();
    });

    test('BufferArray used again after release is invalidated by a lost context', function() {
        var gl = mockup.createFakeRenderer();
        gl.createBuffer = function() {
            return {};
        };

        var b = new BufferArray(BufferArray.ARRAY_BUFFER, new Float32Array(9), 3);
        b.bind(gl);
        b.compile(gl);
        b.releaseGLObjects();

        // Used again, e.g. a geometry released while still drawn
        b.bind(gl);
        b.compile(gl);
        assert.isOk(b._buffer !== undefined && !b.isDirty(), 'Check the buffer was uploaded again');

        GLObject.onLostContext(gl);
        assert.isOk(b._buffer === undefined, 'Check a lost context forgets the buffer');
        assert.isOk(b.isDirty(), 'Check a lost context makes the buffer upload again');
    });
}
