import utils from 'osg/utils';
import notify from 'osg/notify';
import Node from 'osg/Node';
import WebGLCaps from 'osg/WebGLCaps';
import DrawElements from 'osg/DrawElements';
import BufferArray from 'osg/BufferArray';
import TriangleIndexFunctor from 'osg/TriangleIndexFunctor';
import primitiveSet from 'osg/primitiveSet';
import BufferArrayProxy from 'osg/BufferArrayProxy';
import VertexArrayObject from 'osg/VertexArrayObject';
import { mat4 } from 'osg/glMatrix';

/**
 * Geometry manage array and primitives to draw a geometry.
 * @class Geometry
 */

var Geometry = function() {
    Node.call(this);

    this._attributes = {};
    this._primitives = [];

    // function is generated for each Shader Program ID
    // which generates a a special "draw"
    // TODO: could be upon hash of combination of attributes
    // (as multiple shader Programs can use same combination of attributes)
    this._cacheDrawCall = {};

    // VAO cached data, per combination of vertex buffer
    // program id also the cache key
    this._useVAO = undefined;
    this._vao = {};
    this._cacheVertexAttributeBufferList = {};

    // null means the kdTree builder will skip the kdTree creation
    this._shape = undefined;
    this._instancedArrayMap = undefined;

    this._controlledNearFar = undefined;
    this._controlledNearFarProjectionMatrix = undefined;

    // Lazily created LINES geometry sharing this geometry's vertices, used by the
    // CullVisitor when the geometry is culled below a wireframe cull callback.
    // null means there was nothing to create a wireframe from.
    this._wireframeGeometry = undefined;
};

Geometry.enableVAO = true;

/** @lends Geometry.prototype */
utils.createPrototypeNode(
    Geometry,
    utils.objectInherit(Node.prototype, {
        releaseGLObjects: function() {
            if (this.stateset !== undefined) this.stateset.releaseGLObjects();

            for (var keyAttribute in this._attributes) {
                var value = this._attributes[keyAttribute];
                value.releaseGLObjects();
            }

            for (var i = 0, h = this._primitives.length; i < h; i++) {
                var prim = this._primitives[i];
                if (prim.getIndices !== undefined) {
                    var indices = prim.getIndices();
                    if (indices !== undefined && indices !== null) {
                        indices.releaseGLObjects();
                    }
                }
            }

            this.releaseVAO();
            this.releaseWireframeGeometry();
        },

        releaseVAO: function() {
            if (!this._useVAO || !this._glContext) return;

            for (var prgID in this._vao) {
                if (this._vao[prgID]) {
                    this._vao[prgID].releaseGLObjects();
                    this._vao[prgID] = undefined;
                }
            }
        },

        dirty: function() {
            this._cacheDrawCall = {};
            this.releaseVAO();
        },

        getPrimitives: function() {
            // Notify.warn( 'deprecated use instead getPrimitiveSetList' );
            return this.getPrimitiveSetList();
        },

        getAttributes: function() {
            // Notify.warn( 'deprecated use instead getVertexAttributeList' );
            return this.getVertexAttributeList();
        },

        getShape: function() {
            return this._shape;
        },

        setShape: function(shape) {
            this._shape = shape;
        },

        getVertexAttributeList: function() {
            return this._attributes;
        },

        /**
         * Return the primitiveset list
         * If you modify something inside this array
         * you must call dirty() on the Geometry
         */
        getPrimitiveSetList: function() {
            return this._primitives;
        },

        /**
         * Set the buffer array on the attribute name key
         * key is often something like Vertex, Normal, Color, ...
         * for classic geometry
         *
         * if you change a buffer a dirty will be automatically
         * called to rebuild the VAO if needed.
         */
        setVertexAttribArray: function(key, array) {
            if (this._attributes[key] !== array) {
                this._attributes[key] = array;
                this.dirty();
            }
        },

        setAttribArrayDivisor: function(attributeName, divisor) {
            if (this._attributes[attributeName] === undefined) {
                notify.error('Attribute' + attributeName + 'does not exist.');
                return;
            }
            if (this._instancedArrayMap === undefined) this._instancedArrayMap = new window.Map();
            this._instancedArrayMap.set(attributeName, divisor);
        },

        _generateVertexSetup: function(
            validAttributeKeyList,
            validAttributeIndexList,
            includeFirstIndexBuffer
        ) {
            // generate setup for vertex attribute
            // will be used as setup for vao or as is without vao
            var vertexAttributeSetup = [
                '//generated by Geometry::implementation',
                'state.lazyDisablingOfVertexAttributes();',
                'var attr;'
            ];

            for (var i = 0, l = validAttributeKeyList.length; i < l; i++) {
                // Check if the attribute is instanced
                var divisor = undefined;
                if (
                    this._instancedArrayMap &&
                    this._instancedArrayMap.has(validAttributeKeyList[i])
                ) {
                    divisor = this._instancedArrayMap.get(validAttributeKeyList[i]);
                }
                vertexAttributeSetup.push(
                    "attr = this._attributes['" + validAttributeKeyList[i] + "'];"
                );
                vertexAttributeSetup.push(
                    'if ( attr.BufferArrayProxy ) attr = attr.getBufferArray();'
                );
                vertexAttributeSetup.push('if ( !attr.isValid() ) return;');
                vertexAttributeSetup.push(
                    'state.setVertexAttribArray(' +
                        validAttributeIndexList[i] +
                        ', attr, attr.getNormalize(), ' +
                        divisor +
                        ')'
                );
            }

            vertexAttributeSetup.push('state.applyDisablingOfVertexAttributes();');

            if (includeFirstIndexBuffer)
                vertexAttributeSetup.push(
                    'state.setIndexArray( this._primitives[ 0 ].getIndices() );'
                );

            return vertexAttributeSetup;
        },

        _generatePrimitives: function(validPrimitives, hasVertexColor, optimizeVAO) {
            var primitiveSetup = [
                hasVertexColor ? 'state.enableVertexColor();' : 'state.disableVertexColor();'
            ];
            if (optimizeVAO) {
                return primitiveSetup.concat([
                    'var primitive = this._primitives[ ' + validPrimitives[0] + ' ];',
                    'var indexes = primitive.getIndices();',
                    'if ( indexes.isDirty() ) {;',
                    '  indexes.bind( gl );',
                    '  indexes.compile( gl );',
                    '};',
                    'primitive.drawElements( state );'
                ]);
            }

            primitiveSetup.push('var primitives = this._primitives;');
            for (var j = 0, m = validPrimitives.length; j < m; j++) {
                primitiveSetup.push('primitives[' + validPrimitives[j] + '].draw(state);');
            }

            return primitiveSetup;
        },

        /**
         *  Generate a function specific to the Geometry/Program
         *  two version one using VAO and a regular one
         */
        generateDrawCommand: (function() {
            var validAttributeList = [];
            var validAttributeKeyList = [];

            return function(state, program, prgID, validPrimitives) {
                var attributesCacheMap = program._attributesCache;
                var geometryVertexAttributes = this.getVertexAttributeList();

                validAttributeKeyList.length = 0;
                validAttributeList.length = 0;

                // 1 - register valid vertex attributes and color flag

                var attribute, j, m, attr;

                var useVAO = this._useVAO;
                var listVABuff = useVAO ? [] : undefined;

                var hasVertexColor = false;

                for (var key in attributesCacheMap) {
                    attribute = attributesCacheMap[key];
                    attr = geometryVertexAttributes[key];

                    if (attr === undefined) continue;

                    var attributeBuffer = this._attributes[key];

                    // dont use VAO if we have BufferArrayProxy
                    // typically used for morphing
                    if (attributeBuffer instanceof BufferArrayProxy) {
                        attributeBuffer = attributeBuffer.getBufferArray();
                        useVAO = false;
                    }

                    if (!attributeBuffer.isValid()) return undefined;

                    // store for later usage at draw time/update
                    if (useVAO) listVABuff.push(attributeBuffer);

                    if (!hasVertexColor && key === 'Color') hasVertexColor = true;

                    validAttributeKeyList.push(key);
                    validAttributeList.push(attribute);
                }

                var autogeneratedFunction;
                var functionName;

                // generate specific function using VAO or standard
                if (useVAO) {
                    this._cacheVertexAttributeBufferList[prgID] = listVABuff;

                    // if there is only one drawElement we can put the index buffer
                    // in the vao
                    var optimizeIndexBufferVAO =
                        validPrimitives.length === 1 &&
                        this._primitives[validPrimitives[0]] instanceof DrawElements;

                    var vertexAttributeSetup = this._generateVertexSetup(
                        validAttributeKeyList,
                        validAttributeList,
                        optimizeIndexBufferVAO
                    );

                    state.clearVertexAttribCache();

                    var gl = state.getGraphicContext();
                    var vao = new VertexArrayObject(gl);
                    vao.create(gl);
                    state.setVertexArrayObject(vao);
                    this._vao[prgID] = vao;

                    // evaluate the vertexAttribute setup to register into the vao
                    /*jshint evil: true */
                    var vertexSetupCommand = new Function('state', vertexAttributeSetup.join('\n'));
                    /*jshint evil: false */
                    vertexSetupCommand.call(this, state);

                    // setup the program
                    var vaoSetup = [
                        'var gl = state.getGraphicContext();',
                        'var vao = this._vao[ ' + prgID + ' ] ',
                        'var hasChanged = state.setVertexArrayObject( vao );',
                        'if ( hasChanged ) {',
                        '  var vaList = this._cacheVertexAttributeBufferList[ ' + prgID + ' ];',
                        '  var va;'
                    ];
                    for (j = 0, m = listVABuff.length; j < m; j++) {
                        vaoSetup.push('  va = vaList[ ' + j + '];');
                        vaoSetup.push('  if ( va.isDirty() ) {;');
                        vaoSetup.push('    va.bind( gl );');
                        vaoSetup.push('    va.compile( gl );');
                        vaoSetup.push('  };');
                    }
                    vaoSetup.push('}');

                    autogeneratedFunction = vaoSetup
                        .concat(
                            this._generatePrimitives(
                                validPrimitives,
                                hasVertexColor,
                                optimizeIndexBufferVAO
                            )
                        )
                        .join('\n');
                    functionName = 'GeometryDrawImplementationCacheVAO';
                } else {
                    autogeneratedFunction = this._generateVertexSetup(
                        validAttributeKeyList,
                        validAttributeList,
                        false
                    )
                        .concat(this._generatePrimitives(validPrimitives, hasVertexColor, false))
                        .join('\n');
                    functionName = 'GeometryDrawImplementationCache';
                }

                /*jshint evil: true */
                // name the function
                // http://stackoverflow.com/questions/5905492/dynamic-function-name-in-javascript
                var drawCommand = new Function(
                    'state',
                    'return function ' + functionName + '( state ) { ' + autogeneratedFunction + '}'
                )();
                /*jshint evil: false */

                this._cacheDrawCall[prgID] = drawCommand;
                return drawCommand;
            };
        })(),

        _getValidPrimitives: function() {
            var validPrimitives = [];

            for (var i = 0; i < this._primitives.length; i++) {
                var primitive = this._primitives[i];
                if (!primitive.getCount()) {
                    if (!this._warnInvalidPrimitives) {
                        notify.warn(
                            'geometry with instanceID ' +
                                this._instanceID +
                                ' has invalid primitives'
                        );
                        this._warnInvalidPrimitives = true;
                    }
                    continue;
                }
                validPrimitives.push(i);
            }

            return validPrimitives;
        },

        drawImplementation: function(state) {
            if (this._controlledNearFar !== undefined) {
              const aspect = state._lastAppliedProjectionMatrix[5] / state._lastAppliedProjectionMatrix[0];
              const fovY = 2.0 * Math.atan(1.0 / state._lastAppliedProjectionMatrix[5]);
              mat4.perspective(this._controlledNearFarProjectionMatrix, fovY, aspect, this._controlledNearFar[0], this._controlledNearFar[1]);
              state.applyProjectionMatrix(this._controlledNearFarProjectionMatrix);
            }
          
            var program = state.getLastProgramApplied();
            var prgID = program.getInstanceID();

            state.drawGeometry(this);
            var cachedDraw = this._cacheDrawCall[prgID];

            if (!this._vao[prgID]) {
                state.setVertexArrayObject(null);
            } else {
                if (this._vao[prgID].isDirty()) {
                    // need vertex array recreation
                    // ie: lost context
                    cachedDraw = undefined;
                }
            }

            if (cachedDraw) {
                cachedDraw.call(this, state);
                return;
            }

            if (!this._primitives.length) {
                if (!this._warnNoPrimitives) {
                    notify.warn(
                        'geometry with instanceID ' + this._instanceID + ' has no primitives'
                    );
                    this._warnNoPrimitives = true;
                }
                return;
            }

            var validPrimitives = this._getValidPrimitives();
            if (!validPrimitives.length) return;

            // generate cachedDraw
            if (this._useVAO === undefined && Geometry.enableVAO) {
                // will be null if not supported
                this._useVAO = WebGLCaps.instance().hasVAO();
                this._glContext = state.getGraphicContext();
            }

            cachedDraw = this.generateDrawCommand(state, program, prgID, validPrimitives);
            cachedDraw.call(this, state);
            state.setVertexArrayObject(null);
        },

        setBound: function(bb) {
            this._boundingBox = bb;
            this._boundingBoxComputed = true;
        },

        computeBoundingBox: function(boundingBox) {
            if (this._computeBoundingBoxCallback !== undefined) {
                return this._computeBoundingBoxCallback(boundingBox);
            }
            boundingBox.init();

            var vertexArray = this.getVertexAttributeList().Vertex;
            if (vertexArray && vertexArray.getElements() && vertexArray.getItemSize() > 2) {
                var vertexes = vertexArray.getElements();
                var itemSize = vertexArray.getItemSize();

                var min = boundingBox.getMin();
                var max = boundingBox.getMax();

                var minx = min[0];
                var miny = min[1];
                var minz = min[2];
                var maxx = max[0];
                var maxy = max[1];
                var maxz = max[2];

                // if the box is un-initialized min=Inf and max=-Inf
                // we can't simply write if(x > min) [...] else (x < max) [...]
                // most of the time the else condition is run so it's a kinda useless
                // optimization anyway
                for (var idx = 0, l = vertexes.length; idx < l; idx += itemSize) {
                    var v1 = vertexes[idx];
                    var v2 = vertexes[idx + 1];
                    var v3 = vertexes[idx + 2];
                    if (v1 < minx) minx = v1;
                    if (v1 > maxx) maxx = v1;
                    if (v2 < miny) miny = v2;
                    if (v2 > maxy) maxy = v2;
                    if (v3 < minz) minz = v3;
                    if (v3 > maxz) maxz = v3;
                }

                min[0] = minx;
                min[1] = miny;
                min[2] = minz;
                max[0] = maxx;
                max[1] = maxy;
                max[2] = maxz;
            }

            return boundingBox;
        },

        computeBoundingSphere: function(boundingSphere) {
            boundingSphere.init();
            var bb = this.getBoundingBox();
            boundingSphere.expandByBoundingBox(bb);
            return boundingSphere;
        },
        
        setControlledNearFar: function(nearFar) {
            this._controlledNearFar = nearFar;
            this._controlledNearFarProjectionMatrix = (this._controlledNearFar !== undefined ? mat4.create() : undefined);
        },
        
        getControlledNearFar: function() {
          return this._controlledNearFar;
        },
        
        isNearFarControlled: function() {
            return (this._controlledNearFar !== undefined);
        },

        /**
         * Returns a LINES geometry with the triangle edges of this geometry, creating it on first call.
         * The vertex buffer is shared with this geometry, only an index buffer is added.
         * Returns undefined if this geometry has no triangles.
         */
        getOrCreateWireframeGeometry: function() {
            var vertices = this._attributes.Vertex;
            var wireframeGeometry = this._wireframeGeometry;
            if (wireframeGeometry !== undefined) {
                if (wireframeGeometry === null) return undefined;
                // Recreate if the vertex buffer has been replaced
                if (wireframeGeometry.getAttributes().Vertex === vertices) return wireframeGeometry;
                this.releaseWireframeGeometry();
            }

            this._wireframeGeometry = null;
            if (vertices === undefined || !vertices.getElements()) return undefined;

            // Count first to fill a typed array directly, this runs while culling
            var numTriangles = 0;
            var functor = new TriangleIndexFunctor();
            functor.init(this, function(i1, i2, i3) {
                if (i1 !== i2 && i1 !== i3 && i2 !== i3) numTriangles++;
            });
            functor.apply();
            if (numTriangles === 0) return undefined;

            var numVertices = vertices.getElements().length / vertices.getItemSize();
            var IndexArray = numVertices > 65536 ? utils.Uint32Array : utils.Uint16Array;
            var lineIndices = new IndexArray(numTriangles * 6);
            var j = 0;
            functor.init(this, function(i1, i2, i3) {
                if (i1 === i2 || i1 === i3 || i2 === i3) return;
                lineIndices[j++] = i1;
                lineIndices[j++] = i2;
                lineIndices[j++] = i2;
                lineIndices[j++] = i3;
                lineIndices[j++] = i3;
                lineIndices[j++] = i1;
            });
            functor.apply();
            var indices = new BufferArray(BufferArray.ELEMENT_ARRAY_BUFFER, lineIndices, 1);

            wireframeGeometry = new Geometry();
            wireframeGeometry.setName('wireframe');
            wireframeGeometry.getAttributes().Vertex = vertices;
            wireframeGeometry.getPrimitives().push(new DrawElements(primitiveSet.LINES, indices));
            wireframeGeometry.setControlledNearFar(this._controlledNearFar);
            this._wireframeGeometry = wireframeGeometry;
            return wireframeGeometry;
        },

        /**
         * Releases the wireframe geometry created by getOrCreateWireframeGeometry, if any.
         */
        releaseWireframeGeometry: function() {
            var wireframeGeometry = this._wireframeGeometry;
            this._wireframeGeometry = undefined;
            if (!wireframeGeometry) return;

            // The vertex buffer belongs to this geometry, so only release the line indices
            wireframeGeometry.getPrimitives()[0].getIndices().releaseGLObjects();
            wireframeGeometry.releaseVAO();
        }
    }),
    'osg',
    'Geometry'
);

Geometry.appendVertexAttributeToList = function(from, to, postfix) {
    for (var key in from) {
        var keyPostFix = key;
        if (postfix !== undefined) keyPostFix += '_' + postfix;

        to[keyPostFix] = from[key];
    }
};

export default Geometry;
