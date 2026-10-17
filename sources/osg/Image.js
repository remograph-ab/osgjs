import notify from 'osg/notify';
import utils from 'osg/utils';
import Object from 'osg/Object';

var ImageBitmap = window.ImageBitmap || function() {};

var isTypedArrayObject = function(object) {
    return (
        object instanceof Uint8Array ||
        object instanceof Float32Array ||
        object instanceof Uint16Array ||
        object instanceof Uint32Array
    );
};

var ImageObject = function(image) {
    Object.call(this);

    this._imageObject = undefined;
    this._url = undefined;
    this._width = undefined;
    this._height = undefined;
    this._dirty = true;
    this._mipmap = [];
    this._format = 0x1908;

    if (image) {
        this.setImage(image);
    }

    this._isGreyscale = undefined;
};

utils.createPrototypeObject(
    ImageObject,
    utils.objectInherit(Object.prototype, {
        setFormat: function(format) {
          this._format = format;
        },
        
        getFormat: function() {
          return this._format;
        },
      
        dirty: function() {
            this._isGreyscale = undefined;
            this._dirty = true;
        },

        isDirty: function() {
            return this._dirty;
        },

        setDirty: function(bool) {
            this._dirty = bool;
        },

        getImage: function() {
            return this._imageObject instanceof ImageObject
                ? this._imageObject.getImage()
                : this._imageObject;
        },

        getURL: function() {
            return this._url;
        },

        setURL: function(url) {
            this._url = url;
        },

        useOrCreateImage: function(img) {
            return img instanceof ImageObject === false ? new ImageObject(img) : img;
        },
        // Sets the content of the image from an already decoded mipmap pyramid, as produced by
        // Input.getDDS or by the KTX2 reader. Data is
        //     { mipmaps: [ { data, width, height } ], width, height, format, mipmapCount }
        // where format is the GL (internal) format the data is in: a compressed format such as
        // Texture.COMPRESSED_RGBA_BPTC_UNORM_EXT, or Texture.RGBA for plain byte data.
        setImageCompressed: function(data) {
            this._mipmap = data.mipmaps;
            this.setWidth(data.width);
            this.setHeight(data.height);
            this._mipmap.length = data.mipmapCount;
            this._imageObject = this._mipmap[0].data;
            this._format = data.format;
            this.dirty();
        },

        setImageDDS: function(ddsData) {
            this.setImageCompressed(ddsData);
        },
        setImage: function(img) {
            if (!this._url && img && (img.src || img.currentSrc)) {
                // TODO what is currentSrc ?
                this._url = img.src || img.currentSrc;
            }

            this._mipmap.length = 0;

            // img can be an image or an array of image if specify the
            // all mipmap levels
            if (Array.isArray(img)) {
                for (var i = 0, nbImg = img.length; i < nbImg; i++) {
                    this._mipmap.push(this.useOrCreateImage(img[i]));
                }
                this.setWidth(this._mipmap[0].getWidth());
                this.setHeight(this._mipmap[0].getHeight());
            } else {
                this._mipmap.push(img);
            }

            this._imageObject = this._mipmap[0];
            this.dirty();
        },

        isCanvas: function() {
            return this.getImage() instanceof window.HTMLCanvasElement;
        },

        isBitmap: function() {
            return this.getImage() instanceof ImageBitmap;
        },

        isVideo: function() {
            return this.getImage() instanceof window.HTMLVideoElement;
        },

        isImage: function() {
            return this.getImage() instanceof window.Image;
        },

        isTypedArray: function() {
            return isTypedArrayObject(this.getImage());
        },

        setWidth: function(w) {
            this._width = w;
        },

        setHeight: function(h) {
            this._height = h;
        },

        getWidth: function() {
            var img = this.getImage();
            if (this.isImage()) {
                return img.naturalWidth;
            } else if (this.isVideo()) {
                return img.videoWidth;
            } else if (this.isCanvas() || this.isBitmap()) {
                return img.width;
            }
            return this._width;
        },

        getHeight: function() {
            var img = this.getImage();
            if (this.isImage()) {
                return img.naturalHeight;
            } else if (this.isVideo()) {
                return img.videoHeight;
            } else if (this.isCanvas() || this.isBitmap()) {
                return img.height;
            }
            return this._height;
        },

        isGreyscale: function(nbSamples) {
            if (this._isGreyscale !== undefined) return this._isGreyscale;

            if (
                this._imageObject !== undefined &&
                this.isReady() &&
                this._isGreyscale === undefined
            ) {
                var canvas = this._imageObject;
                if (!this.isCanvas()) {
                    canvas = document.createElement('canvas');
                }
                var ctx = canvas.getContext('2d');
                canvas.width = this._imageObject.width;
                canvas.height = this._imageObject.height;
                ctx.drawImage(this._imageObject, 0, 0);

                var sampleX, sampleY;
                // cap sample if needed
                if (!nbSamples) {
                    sampleX = canvas.width;
                    sampleY = canvas.height;
                }
                if (nbSamples > 0) {
                    nbSamples = Math.min(Math.min(canvas.width, canvas.height), nbSamples);
                    sampleX = sampleY = nbSamples;
                }

                var isGreyscale = true;
                var xFactor = canvas.width / sampleX;
                var yFactor = canvas.height / sampleY;
                for (var i = 0; i < sampleX; i++) {
                    for (var j = 0; j < sampleY; j++) {
                        var x = Math.floor(xFactor * (i + 0.5)),
                            y = Math.floor(yFactor * (j + 0.5));
                        var data = ctx.getImageData(x, y, 1, 1).data;
                        if (!(data[0] === data[1] && data[0] === data[2])) {
                            isGreyscale = false;
                            break;
                        }
                    }
                }
                this._isGreyscale = isGreyscale;
            }

            return this._isGreyscale;
        },

        isReady: function() {
            // image is a osgImage
            if (this._imageObject && this._imageObject instanceof ImageObject) {
                return this._imageObject.isReady();
            }

            // image are ready for static data
            if (this.isCanvas() || this.isTypedArray() || this.isBitmap()) {
                return true;
            }

            if (this.isImage()) {
                var image = this.getImage();
                if (image.complete) {
                    if (image.naturalWidth !== undefined && image.naturalWidth === 0) {
                        return false;
                    }

                    return true;
                }
            }

            if (this.isVideo()) {
                if (this.getWidth() !== 0) return true;
            }

            // here means we have something but we don't know what
            // Check if the object is not a image
            // by "feature" detect it
            var imageTry = this.getImage();
            if (imageTry.complete) {
                if (imageTry.naturalWidth !== undefined && imageTry.naturalWidth === 0) {
                    return false;
                }
                return true;
            }

            // It's not something we recognise
            /*develblock:start*/
            notify.warn("Warning can't detect image object ");
            /*develblock:end*/
            return false;
        },

        getMipmap: function() {
            return this._mipmap;
        },

        hasMipmap: function() {
            return this._mipmap.length > 1;
        },

        release: function() {
            this._mipmap.length = 0;
            this._imageObject = undefined;
        },

        // Return -1 if less, 0 if equal and 1 if greater
        compare: function(img) {
            if (this._url < img._url) {
                return -1;
            }
            if (this._url > img._url) {
                return 1;
            }
            if (this._width < img._width) {
                return -1;
            }
            if (this._width > img._width) {
                return 1;
            }
            if (this._height < img._height) {
                return -1;
            }
            if (this._height > img._height) {
                return 1;
            }
            if (this._dirty < img._dirty) {
                return -1;
            }
            if (this._dirty > img._dirty) {
                return 1;
            }
            if (this._format < img._format) {
                return -1;
            }
            if (this._format > img._format) {
                return 1;
            }
            if (this._isGreyscale < img._isGreyscale) {
                return -1;
            }
            if (this._isGreyscale > img._isGreyscale) {
                return 1;
            }

            var thisImage = this.getImage();
            var otherImage = img.getImage();
            if (!thisImage && otherImage) {
                return -1;
            }
            if (thisImage && !otherImage) {
                return 1;
            }
            if (thisImage instanceof window.HTMLCanvasElement && !(otherImage instanceof window.HTMLCanvasElement)) {
                return -1;
            }
            if (!(thisImage instanceof window.HTMLCanvasElement) && otherImage instanceof window.HTMLCanvasElement) {
                return 1;
            }
            if (thisImage instanceof window.HTMLCanvasElement && otherImage instanceof window.HTMLCanvasElement) {
              // Sorry, no better way
                if (thisImage.width < otherImage.width) {
                    return -1;
                }
                if (thisImage.width > otherImage.width) {
                    return 1;
                }
                if (thisImage.height < otherImage.height) {
                    return -1;
                }
                if (thisImage.height > otherImage.height) {
                    return 1;
                }
                else {
                    return 0;
                }
            }
            if (thisImage instanceof ImageBitmap && !(otherImage instanceof ImageBitmap)) {
                return -1;
            }
            if (!(thisImage instanceof ImageBitmap) && otherImage instanceof ImageBitmap) {
                return 1;
            }
            if (thisImage instanceof ImageBitmap && otherImage instanceof ImageBitmap) {
                // Sorry, no better way
                if (thisImage.width < otherImage.width) {
                    return -1;
                }
                if (thisImage.width > otherImage.width) {
                    return 1;
                }
                if (thisImage.height < otherImage.height) {
                    return -1;
                }
                if (thisImage.height > otherImage.height) {
                    return 1;
                }
                else {
                    return 0;
                }
            }
            if (thisImage instanceof window.HTMLVideoElement && !(otherImage instanceof window.HTMLVideoElement)) {
                return -1;
            }
            if (!(thisImage instanceof window.HTMLVideoElement) && otherImage instanceof window.HTMLVideoElement) {
                return 1;
            }
            if (thisImage instanceof window.HTMLVideoElement && otherImage instanceof window.HTMLVideoElement) {
                // Sorry, no better way
                if (thisImage.videoWidth < otherImage.videoWidth) {
                    return -1;
                }
                if (thisImage.videoWidth > otherImage.videoWidth) {
                    return 1;
                }
                if (thisImage.videoHeight < otherImage.videoHeight) {
                    return -1;
                }
                if (thisImage.videoHeight > otherImage.videoHeight) {
                    return 1;
                }
                else {
                    return 0;
                }
            }
            if (thisImage instanceof window.Image && !(otherImage instanceof window.Image)) {
                return -1;
            }
            if (!(thisImage instanceof window.Image) && otherImage instanceof window.Image) {
                return 1;
            }
            if (thisImage instanceof window.Image && otherImage instanceof window.Image) {
                if (thisImage.width < otherImage.width) {
                    return -1;
                }
                if (thisImage.width > otherImage.width) {
                    return 1;
                }
                if (thisImage.height < otherImage.height) {
                    return -1;
                }
                if (thisImage.height > otherImage.height) {
                    return 1;
                }
                if (thisImage.src < otherImage.src) {
                    return -1;
                }
                if (thisImage.src > otherImage.src) {
                    return 1;
                }
                else {
                    return 0;
                }
            }
            if (isTypedArrayObject(thisImage) && !isTypedArrayObject(otherImage)) {
                return -1;
            }
            if (!isTypedArrayObject(thisImage) && isTypedArrayObject(otherImage)) {
                return 1;
            }
            if (isTypedArrayObject(thisImage) && isTypedArrayObject(otherImage)) {
                // Sorry, no better way
                if (thisImage.length < otherImage.length) {
                    return -1;
                }
                if (thisImage.length > otherImage.length) {
                    return 1;
                }
                else {
                    return 0;
                }
            }
            return 0;
        }
    }),
    'osg',
    'Image'
);

export default ImageObject;
