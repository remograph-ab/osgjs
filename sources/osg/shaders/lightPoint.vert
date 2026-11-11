attribute vec3 Vertex;
attribute vec2 Corner;
attribute vec4 Color;
attribute float Radius;
attribute float Intensity;
attribute float Animated;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
uniform vec2 uLightPointViewport;
uniform vec2 uLightPointPixelSize;
uniform float uLightPointMaxDistance;
uniform vec2 uLightPointGlow;
uniform float uLightPointStar;
varying vec2 vPixel;
varying float vPixelRadius;
varying float vGlowRadius;
varying float vGlowIntensity;
varying float vStar;
varying float vRayLength;
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

    // The quad covers the soft edge of the clamped diameter and the glow.
    // Lights brighter than 1, e.g. strobes, keep growing beyond the maximum
    // pixel size through a larger and stronger glow: its area grows with the
    // square root of the intensity, like the light's own area.
    float radius = 0.5 * max(size, 1.0);
    float glare = sqrt(max(Intensity, 1.0));
    // Glow radius, also sizing the star when the glow is off.
    float glowSize = (radius * max(uLightPointGlow.x, 1.0) + 2.0) * sqrt(glare);
    float glowRadius = uLightPointGlow.y > 0.0 ? glowSize : 0.0;
    // Animated lights, e.g. strobes, flash with a star of soft rays.
    vStar = Animated * uLightPointStar;
    vRayLength = vStar > 0.0 ? 3.0 * glowSize : 0.0;
    float extent = max(max(1.6 * radius + 1.0, glowRadius), vRayLength);
    vPixelRadius = radius;
    vGlowRadius = max(glowRadius, 0.00001);
    vGlowIntensity = min(uLightPointGlow.y * glare, 1.0);
    vPixel = Corner * extent;
    clip.xy += Corner * (2.0 * extent) / max(uLightPointViewport, vec2(1.0)) * clip.w;
    gl_Position = clip;
}