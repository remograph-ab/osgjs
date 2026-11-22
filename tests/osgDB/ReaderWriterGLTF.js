import { assert } from 'chai';
import ReaderWriterGLTF from 'osgPlugins/ReaderWriterGLTF';
import Texture from 'osg/Texture';

export default function() {
    test('ReaderWriterGLTF texture sampler', function() {
        var reader = new ReaderWriterGLTF();
        reader.init();
        reader._gltfJSON = {
            samplers: [{ magFilter: Texture.NEAREST, minFilter: Texture.NEAREST, wrapS: Texture.CLAMP_TO_EDGE }],
            textures: [{ source: 0, sampler: 0 }, { source: 0 }],
            images: [{}]
        };

        var sampled = reader._texture({ index: 0 });
        assert.equal(sampled.getMinFilter(), Texture.NEAREST, 'sampler min filter');
        assert.equal(sampled.getMagFilter(), Texture.NEAREST, 'sampler mag filter');
        assert.equal(sampled.getWrapS(), Texture.CLAMP_TO_EDGE, 'sampler wrap s');
        assert.equal(sampled.getWrapT(), Texture.REPEAT, 'default wrap t');

        var unsampled = reader._texture({ index: 1 });
        assert.equal(unsampled.getMinFilter(), Texture.LINEAR_MIPMAP_LINEAR, 'trilinear without a sampler');
        assert.equal(unsampled.getMagFilter(), Texture.LINEAR, 'linear without a sampler');
        assert.equal(unsampled.getWrapS(), Texture.REPEAT, 'default wrap s');
    });

    test('ReaderWriterGLTF concurrent reads with one reader', function() {
        // The registered reader is shared, e.g. by several models loading the same file at once
        var createJSON = function(name) {
            return JSON.stringify({
                asset: { version: '2.0' },
                buffers: [],
                bufferViews: [],
                accessors: [],
                materials: [],
                meshes: [],
                nodes: [{ name: name, translation: [1, 2, 3] }],
                scenes: [{ nodes: [0] }]
            });
        };
        var reader = new ReaderWriterGLTF();
        var readA = reader.readNodeURL('a.gltf', { filesMap: { 'a.gltf': createJSON('A') } });
        var readB = reader.readNodeURL('b.gltf', { filesMap: { 'b.gltf': createJSON('B') } });
        return Promise.all([readA, readB]).then(function(roots) {
            assert.equal(roots[0].getChildren()[0].getName(), 'A', 'first read keeps its file');
            assert.equal(roots[1].getChildren()[0].getName(), 'B', 'second read keeps its file');
        });
    });
}
