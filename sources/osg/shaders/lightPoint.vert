attribute vec3 Vertex;
attribute vec2 Corner;
attribute vec4 Color;
attribute float Radius;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
uniform vec2 uLightPointViewport;
uniform vec2 uLightPointPixelSize;
uniform float uLightPointMaxDistance;
varying vec2 vPixel;
varying float vPixelRadius;
varying vec4 vColor;

void main(void) {
    vec4 eye = uModelViewMatrix * vec4(Vertex, 1.0);
    vec4 clip = uProjectionMatrix * eye;
    float scale = max(length(uModelViewMatrix[0].xyz),
                      max(length(uModelViewMatrix[1].xyz), length(uModelViewMatrix[2].xyz)));
    // Projected diameter in pixels; Min/MaxPixelSize clamp diameters (OpenFlight/osgSim).
    float diameter = Radius * scale * abs(uProjectionMatrix[1][1]) *
                     uLightPointViewport.y / max(abs(clip.w), 0.00001);
    float size = clamp(diameter, uLightPointPixelSize.x, uLightPointPixelSize.y);
    // As osgSim: subpixel lights dim linearly, lights enlarged to the minimum
    // size keep at least two thirds of their brightness.
    float enlarged = 2.0 / 3.0 + sqrt(min(diameter / max(size, 0.00001), 1.0)) / 3.0;
    float brightness = size < 1.0 ? size : enlarged;
    float distanceRatio = length(eye.xyz) / max(uLightPointMaxDistance, 0.00001);
    float fade = 1.0 - smoothstep(0.9, 1.0, distanceRatio);
    vColor = vec4(Color.rgb, Color.a * brightness * fade);

    // The quad covers the soft edge and glow tail around the clamped diameter.
    float radius = 0.5 * max(size, 1.0);
    float extent = 2.0 * radius + 1.5;
    vPixelRadius = radius;
    vPixel = Corner * extent;
    clip.xy += Corner * (2.0 * extent) / max(uLightPointViewport, vec2(1.0)) * clip.w;
    gl_Position = clip;
}