precision mediump float;
varying vec2 vPixel;
varying float vPixelRadius;
varying vec4 vColor;
uniform float uLightPointDepthPass;

void main(void) {
    float d = length(vPixel);
    float r = vPixelRadius;
    // Smooth falloff centered on the light-point radius, so the half-brightness
    // diameter equals the specified diameter.
    float softness = max(0.6 * r, 1.0);
    float core = 1.0 - smoothstep(r - softness, r + softness, d);
    // Faint glow tail reaching about one diameter beyond the edge.
    float glow = 1.0 - smoothstep(r, 2.0 * r + 1.5, d);
    glow = 0.25 * glow * glow;
    float shape = core + (1.0 - core) * glow;
    // The depth-only pass marks just the bright core of visible lights.
    if (uLightPointDepthPass > 0.5 && (shape < 0.5 || vColor.a < 0.02)) discard;
    float alpha = vColor.a * shape;
    gl_FragColor = vec4(vColor.rgb * alpha, alpha);
}