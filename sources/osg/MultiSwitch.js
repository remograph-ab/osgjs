/*
 * Ported from OpenSceneGraph's osgSim::MultiSwitch.
 * Copyright (C) 1998-2006 Robert Osfield.
 * Licensed under the OpenSceneGraph Public License, version 0.0 or later.
 */
import utils from 'osg/utils';
import Node from 'osg/Node';
import NodeVisitor from 'osg/NodeVisitor';

/**
 * A node that switches between sets of selected children (OpenFlight switch masks).
 * Each switch set holds one boolean per child, and only the active switch set is
 * used by active traversals.
 * @class MultiSwitch
 */
var MultiSwitch = function() {
    Node.call(this);
    this._newChildDefaultValue = true;
    this._activeSwitchSet = 0;
    this._values = [];
    this._valueNames = [];
};

utils.createPrototypeNode(
    MultiSwitch,
    utils.objectInherit(Node.prototype, {
        setNewChildDefaultValue: function(value) {
            this._newChildDefaultValue = value;
        },
        getNewChildDefaultValue: function() {
            return this._newChildDefaultValue;
        },

        addChild: function(child) {
            if (!Node.prototype.addChild.call(this, child)) return false;
            for (var i = 0; i < this._values.length; i++) {
                var values = this._values[i];
                while (values.length < this.children.length) values.push(this._newChildDefaultValue);
            }
            return true;
        },

        insertChild: function(index, child) {
            if (!Number.isInteger(index) || index < 0)
                throw new RangeError('MultiSwitch child index is out of range');
            if (!Node.prototype.addChild.call(this, child)) return false;
            if (index < this.children.length - 1) {
                this.children.splice(index, 0, this.children.pop());
            }
            for (var i = 0; i < this._values.length; i++) {
                var values = this._values[i];
                if (index >= values.length) values.push(this._newChildDefaultValue);
                else values.splice(index, 0, this._newChildDefaultValue);
            }
            return true;
        },

        removeChild: function(child) {
            var position = this.children.indexOf(child);
            if (position === -1) return false;
            for (var i = 0; i < this._values.length; i++) {
                this._values[i].splice(position, 1);
            }
            Node.prototype.removeChild.call(this, child);
            return true;
        },

        removeChildren: function() {
            for (var i = 0; i < this._values.length; i++) {
                this._values[i].length = 0;
            }
            Node.prototype.removeChildren.call(this);
        },

        setValue: function(switchSet, pos, value) {
            this._expandToEncompassSwitchSet(switchSet);
            var values = this._values[switchSet];
            while (values.length <= pos) values.push(this._newChildDefaultValue);
            values[pos] = value;
        },
        getValue: function(switchSet, pos) {
            var values = this._values[switchSet];
            if (!values || pos >= values.length) return false;
            return values[pos];
        },

        setChildValue: function(child, switchSet, value) {
            this._expandToEncompassSwitchSet(switchSet);
            var pos = this.children.indexOf(child);
            if (pos === -1) return;
            this._values[switchSet][pos] = value;
        },
        getChildValue: function(child, switchSet) {
            return this.getValue(switchSet, this.children.indexOf(child));
        },

        setAllChildrenOff: function(switchSet) {
            this._newChildDefaultValue = false;
            this._expandToEncompassSwitchSet(switchSet);
            this._values[switchSet].fill(false);
            return true;
        },
        setAllChildrenOn: function(switchSet) {
            this._newChildDefaultValue = true;
            this._expandToEncompassSwitchSet(switchSet);
            this._values[switchSet].fill(true);
            return true;
        },
        setSingleChildOn: function(switchSet, pos) {
            this._expandToEncompassSwitchSet(switchSet);
            this._values[switchSet].fill(false);
            this.setValue(switchSet, pos, true);
            return true;
        },

        setActiveSwitchSet: function(switchSet) {
            this._activeSwitchSet = switchSet;
        },
        getActiveSwitchSet: function() {
            return this._activeSwitchSet;
        },
        getNumSwitchSets: function() {
            return this._values.length;
        },

        setSwitchSetList: function(switchSetList) {
            this._values = switchSetList.map(function(values) {
                return values.slice();
            });
            this._valueNames.length = Math.min(this._valueNames.length, this._values.length);
            while (this._valueNames.length < this._values.length) this._valueNames.push('');
        },
        getSwitchSetList: function() {
            return this._values;
        },
        setValueList: function(switchSet, values) {
            this._expandToEncompassSwitchSet(switchSet);
            this._values[switchSet] = values.slice();
        },
        getValueList: function(switchSet) {
            return this._values[switchSet];
        },

        setValueName: function(switchSet, name) {
            this._expandToEncompassSwitchSet(switchSet);
            this._valueNames[switchSet] = name;
        },
        getValueName: function(switchSet) {
            return this._valueNames[switchSet];
        },

        traverse: function(visitor) {
            if (visitor.traversalMode === NodeVisitor.TRAVERSE_ACTIVE_CHILDREN) {
                var values = this._values[this._activeSwitchSet];
                if (!values) return;
                var children = this.children;
                for (var i = 0, l = Math.min(children.length, values.length); i < l; i++) {
                    if (values[i] === true) children[i].accept(visitor);
                }
            } else {
                Node.prototype.traverse.call(this, visitor);
            }
        },

        _expandToEncompassSwitchSet: function(switchSet) {
            while (this._values.length <= switchSet) {
                var values = [];
                for (var i = 0; i < this.children.length; i++) values.push(this._newChildDefaultValue);
                this._values.push(values);
                this._valueNames.push('');
            }
            while (this._valueNames.length < this._values.length) this._valueNames.push('');
        }
    }),
    'osg',
    'MultiSwitch'
);

export default MultiSwitch;
