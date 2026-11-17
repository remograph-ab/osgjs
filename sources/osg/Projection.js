import utils from 'osg/utils';
import Node from 'osg/Node';
import { mat4 } from 'osg/glMatrix';

var Projection = function() {
    Node.call(this);
    this.projection = mat4.create();
};

utils.createPrototypeNode(
    Projection,
    utils.objectInherit(Node.prototype, {
        _copyFrom: function(node, copyOp) {
            Node.prototype._copyFrom.call(this, node, copyOp);
            this.projection = mat4.copy(mat4.create(), node.projection);
        },

        getProjectionMatrix: function() {
            return this.projection;
        },
        setProjectionMatrix: function(m) {
            this.projection = m;
        }
    }),
    'osg',
    'Projection'
);

export default Projection;
