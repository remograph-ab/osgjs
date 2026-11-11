precision mediump float;
varying vec2 vPixel;
varying float vPixelRadius;
varying float vGlowRadius;
varying float vGlowIntensity;
varying float vStar;
varying float vRayLength;
varying vec4 vColor;
uniform float uLightPointDepthPass;

// A soft ray through the center, along dir in both directions, widening and fading towards its tips.
float ray(vec2 p, vec2 dir, float len) {
    float along = abs(dot(p, dir));
    float across = abs(dot(p, vec2(-dir.y, dir.x)));
    float width = 1.5 + 0.08 * along;
    float fade = 1.0 - smoothstep(0.0, len, along);
    return exp(-across * across / (width * width)) * fade * fade;
}

void main(void) {
    float d = length(vPixel);
    float r = vPixelRadius;
    // Smooth falloff centered on the light-point radius, so the half-brightness
    // diameter equals the specified diameter.
    float softness = max(0.6 * r, 1.0);
    float core = 1.0 - smoothstep(r - softness, r + softness, d);
    // The depth-only pass marks just the bright core of visible lights.
    if (uLightPointDepthPass > 0.5 && (core < 0.5 || vColor.a < 0.02)) discard;
    // Glow, like the glare of bright lights in a camera or the eye.
    float glow = 1.0 - smoothstep(0.0, vGlowRadius, d);
    glow = vGlowIntensity * glow * glow;
    float shape = core + (1.0 - core) * glow;
    if (vStar > 0.0) {
        // Six rays, 60 degrees apart, of slightly different lengths.
        float rays = ray(vPixel, vec2(0.978, 0.208), vRayLength) +
                     ray(vPixel, vec2(0.309, 0.951), 0.75 * vRayLength) +
                     ray(vPixel, vec2(-0.669, 0.743), 0.85 * vRayLength);
        float star = vStar * min(rays, 1.0);
        shape += (1.0 - shape) * star;
    }
    float alpha = vColor.a * shape;
    gl_FragColor = vec4(vColor.rgb * alpha, alpha);
}