import utils from 'osg/utils';

/**
 * Controls how a scene graph is cloned by Node.clone, and remembers the copies made during one clone operation,
 * so that objects shared within the source graph are also shared within the copy (e.g. a node with several
 * parents, an update callback set on several nodes or light point data shared by several light points).
 *
 * Node types implement cloning by overriding Node._copyFrom, calling the parent class implementation first.
 * Every node class must do so, also when it has nothing more to copy, see the Node clone tests.
 *
 * By default, everything that can be shared between independent instances is shared, i.e. state sets, vertex
 * and index buffers, textures and animation key frames, while everything with per-instance state is copied,
 * i.e. nodes, transforms, switch values and animation update callbacks.
 * @class CopyOp
 * @param { object } [options]
 * @param { boolean } [options.shareGeometries=true] Share plain geometries between the source and the copy,
 *   instead of creating new geometries sharing vertex buffers and primitives. Geometries with per-instance
 *   state, like RigGeometry and MorphGeometry, are always copied.
 * @param { boolean } [options.shareStateSets=true] Share state sets between the source and the copy.
 */
var CopyOp = function(options) {
    this._shareGeometries = !(options && options.shareGeometries === false);
    this._shareStateSets = !(options && options.shareStateSets === false);
    this._copies = new window.Map();
};

utils.createPrototypeObject(
    CopyOp,
    {
        getShareGeometries: function() {
            return this._shareGeometries;
        },

        getShareStateSets: function() {
            return this._shareStateSets;
        },

        /**
         * Returns the copy made of an object during this clone operation, if any.
         * @param { object } original The source object.
         * @returns { object | undefined } The copy.
         */
        getCopy: function(original) {
            return this._copies.get(original);
        },

        /**
         * Registers the copy of an object, before copying its contents, to handle shared and circular references.
         * @param { object } original The source object.
         * @param { object } copy The copy.
         */
        registerCopy: function(original, copy) {
            this._copies.set(original, copy);
        },

        /**
         * Clones a node, or returns its copy if already cloned during this operation.
         * @param { Node } node The source node.
         * @returns { Node } The cloned node, which may be the node itself for shared geometries.
         */
        cloneNode: function(node) {
            if (node === undefined || node === null) return node;
            var copy = this._copies.get(node);
            if (copy !== undefined) return copy;
            if (node._isSharedInCopy(this)) {
                this._copies.set(node, node);
                return node;
            }
            return node.clone(this);
        },

        /**
         * Returns the state set to use in a copy.
         * @param { StateSet } stateSet The source state set.
         * @returns { StateSet } The state set, shared unless shareStateSets is false.
         */
        copyStateSet: function(stateSet) {
            if (!stateSet || this._shareStateSets) return stateSet;
            var copy = this._copies.get(stateSet);
            if (copy !== undefined) return copy;
            copy = stateSet.clone !== undefined ? stateSet.clone(this) : stateSet;
            this._copies.set(stateSet, copy);
            return copy;
        },

        /**
         * Clones a callback with per-instance state, i.e. one with a clone(copyOp) function, or shares it otherwise.
         * @param { object } callback The source callback.
         * @returns { object } The cloned or shared callback.
         */
        cloneCallback: function(callback) {
            if (!callback || typeof callback.clone !== 'function') return callback;
            var copy = this._copies.get(callback);
            if (copy !== undefined) return copy;
            copy = callback.clone(this);
            this._copies.set(callback, copy);
            return copy;
        },

        /**
         * Deep copies plain data (arrays, typed arrays and plain objects), keeping data shared within the source
         * shared within the copy. Class instances, e.g. textures and state attributes, are shared, not copied.
         * @param { * } data The source data.
         * @returns { * } The copy.
         */
        copyData: function(data) {
            if (data === null || typeof data !== 'object') return data;
            var copy = this._copies.get(data);
            if (copy !== undefined) return copy;
            if (ArrayBuffer.isView(data)) {
                copy = data.slice();
            } else if (Array.isArray(data)) {
                copy = [];
                this._copies.set(data, copy);
                for (var i = 0; i < data.length; i++) copy.push(this.copyData(data[i]));
                return copy;
            } else if (Object.getPrototypeOf(data) === Object.prototype) {
                copy = {};
                this._copies.set(data, copy);
                var keys = Object.keys(data);
                for (var k = 0; k < keys.length; k++) copy[keys[k]] = this.copyData(data[keys[k]]);
                return copy;
            } else {
                return data;
            }
            this._copies.set(data, copy);
            return copy;
        }
    },
    'osg',
    'CopyOp'
);

export default CopyOp;
