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
}
