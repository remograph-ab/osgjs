import utils from 'osg/utils';
import NodeVisitor from 'osg/NodeVisitor';
import Geometry from 'osg/Geometry';
import StateSet from 'osg/StateSet';
import StateAttribute from 'osg/StateAttribute';
import Material from 'osg/Material';
import PolygonOffset from 'osg/PolygonOffset';
import { vec4 } from 'osg/glMatrix';

/**
 * Cull callback drawing the geometries below its node as wireframe.
 * The wireframe is created while culling, so it follows LOD changes and
 * geometries paged in later, and is removed again by removing the callback.
 *
 *   node.setCullCallback(new osgUtil.WireframeCullCallback(true));
 *   ...
 *   node.setCullCallback(undefined);
 *   osgUtil.WireframeCullCallback.releaseWireframeGeometries(node);
 *
 * @class WireframeCullCallback
 * @param {Boolean} scribed (optional) True to draw the solid geometry below the wireframe, false for wireframe only. Default is true.
 */
var WireframeCullCallback = function(scribed) {
    this._scribed = scribed !== undefined ? scribed : true;

    var black = vec4.fromValues(0.0, 0.0, 0.0, 1.0);
    var material = new Material();
    material.setAmbient(black);
    material.setDiffuse(black);
    material.setSpecular(black);
    material.setEmission(black);
    this._stateSet = new StateSet();
    this._stateSet.setAttributeAndModes(
        material,
        StateAttribute.ON | StateAttribute.OVERRIDE | StateAttribute.PROTECTED
    );

    // "Sink" the solid geometry below the wireframe (PolygonOffset doesn't work for lines)
    this._solidStateSet = new StateSet();
    this._solidStateSet.setAttributeAndModes(new PolygonOffset(1.0, 1.0), StateAttribute.ON);
};

utils.createPrototypeObject(
    WireframeCullCallback,
    {
        getScribed: function() {
            return this._scribed;
        },

        setScribed: function(scribed) {
            this._scribed = scribed;
        },

        /**
         * The stateset used for the wireframe lines, applied on top of the state above the node.
         */
        getStateSet: function() {
            return this._stateSet;
        },

        setStateSet: function(stateSet) {
            this._stateSet = stateSet;
        },

        cull: function(node, cullVisitor) {
            cullVisitor.pushWireframe(this, node);
            if (this._scribed) cullVisitor.pushStateSet(this._solidStateSet);

            cullVisitor.traverse(node);

            if (this._scribed) cullVisitor.popStateSet();
            cullVisitor.popWireframe();

            // Already traversed
            return false;
        }
    },
    'osgUtil',
    'WireframeCullCallback'
);

var ReleaseWireframeVisitor = function() {
    NodeVisitor.call(this, NodeVisitor.TRAVERSE_ALL_CHILDREN);
};

utils.createPrototypeObject(
    ReleaseWireframeVisitor,
    utils.objectInherit(NodeVisitor.prototype, {
        apply: function(node) {
            if (node instanceof Geometry) node.releaseWireframeGeometry();
            this.traverse(node);
        }
    }),
    'osgUtil',
    'ReleaseWireframeVisitor'
);

/**
 * Releases the wireframe geometries cached on the geometries below node.
 * @param {Node} node The node that had a WireframeCullCallback.
 */
WireframeCullCallback.releaseWireframeGeometries = function(node) {
    node.accept(new ReleaseWireframeVisitor());
};

export default WireframeCullCallback;
