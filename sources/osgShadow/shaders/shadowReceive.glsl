#ifdef _OUT_DISTANCE
#define OPT_ARG_outDistance ,out float outDistance
#define OPT_INSTANCE_ARG_outDistance ,outDistance
#else
#define OPT_ARG_outDistance
#define OPT_INSTANCE_ARG_outDistance
#endif

#ifdef _ATLAS_SHADOW
#define OPT_ARG_atlasSize ,const in vec4 atlasSize
#else
#define OPT_ARG_atlasSize
#endif

#ifdef _NORMAL_OFFSET
#define OPT_ARG_normalBias ,const in float normalBias
#else
#define OPT_ARG_normalBias
#endif

#ifdef _JITTER_OFFSET
#define OPT_ARG_jitter ,const in float jitter
#define OPT_INSTANCE_ARG_jitter ,jitter
#else
#define OPT_ARG_jitter
#define OPT_INSTANCE_ARG_jitter
#endif

#pragma include "tapPCF.glsl"

#pragma DECLARE_FUNCTION DERIVATIVES:enable
float shadowReceive(const in bool lighted,
                    const in vec3 normalWorld,
                    const in vec3 vertexWorld,

                    const in sampler2D shadowTexture,

                    const in vec2 shadowSize,
                    const in vec3 shadowProjection,

                    const in vec4 shadowViewRight,
                    const in vec4 shadowViewUp,
                    const in vec4 shadowViewLook,


                    const in vec2 shadowDepthRange,
                    const in float shadowBias,
                    const in float debugRegion
                    OPT_ARG_atlasSize
                    OPT_ARG_normalBias
                    OPT_ARG_outDistance
                    OPT_ARG_jitter) {

    // 0 for early out
    bool earlyOut = false;

    // Calculate shadow amount
    float shadow = 1.0;

    // diagnostic (window.SHADOW_RXDEBUG): records WHY a fragment ends up unshadowed
    // so we can tell a region-boundary earlyOut apart from a caster/paging gap.
    // 0=tested normally, 1=no casters, 2=behind cam, 3=outside light UV,
    // 4=closer to light than region (near plane), 5=beyond region (far plane).
    float dbgReason = 0.0;

    // NOTE: shadow occlusion is a geometric fact (is a caster between this
    // fragment and the light?) and must NOT be gated on whether the surface
    // faces the light (dotNL > 0). Stock osgjs short-circuited to shadow = 0.0
    // for back-facing fragments as a micro-optimization (their diffuse is 0
    // anyway), but that breaks flat/fake-lit terrain that is shaded independently
    // of its normal: those receivers never reached the real depth compare and the
    // whole shadowed region collapsed to a uniform dark blanket. Always compute
    // the real shadow below; back-facing lit surfaces still have diffuse 0 so
    // this is a no-op for them.

    if (shadowDepthRange.x == shadowDepthRange.y) {
        earlyOut = true;
        dbgReason = 1.0;
    }

    vec4 shadowVertexEye;
    vec4 shadowNormalEye;
    float shadowReceiverZ = 0.0;
    vec4 shadowVertexProjected;
    vec2 shadowUV;
    float N_Dot_L;
    float invDepthRange;

    // fade shadows out towards the border of the shadow map, so that when the
    // shadow frustum is bounded (ShadowMap max distance) distant geometry leaving
    // the shadowed region fades out smoothly instead of with a hard edge.
    float shadowFade = 1.0;

    if (!earlyOut) {

        shadowVertexEye.x = dot(shadowViewRight.xyz, vertexWorld.xyz) + shadowViewRight.w;
        shadowVertexEye.y = dot(shadowViewUp.xyz, vertexWorld.xyz) + shadowViewUp.w;
        shadowVertexEye.z = dot(shadowViewLook.xyz, vertexWorld.xyz) + shadowViewLook.w;
        shadowVertexEye.w = 1.0;


        // derivated, only need z.
        //vec3 shadowLightDir = vec3(0.0, 0.0, 1.0); // in shadow view light is camera
        //shadowNormalEye =  shadowViewMatrix * normalFront;
        //shadowNormalEye.x = dot(shadowViewRight.xyz, normalWorld.xyz);
        //shadowNormalEye.y = dot(shadowViewUp.xyz, normalWorld.xyz);
        shadowNormalEye.z = dot(shadowViewLook.xyz, normalWorld.xyz);
        //shadowNormalEye.w = 0.0;

        //N_Dot_L = dot(shadowNormalEye.xyz, shadowLightDir);
        N_Dot_L = shadowNormalEye.z;

        if (!earlyOut) {

            invDepthRange = 1.0 / (shadowDepthRange.y - shadowDepthRange.x);

#ifdef _NORMAL_OFFSET

            // http://www.dissidentlogic.com/old/images/NormalOffsetShadows/GDC_Poster_NormalOffset.png
            float normalOffsetScale = clamp(1.0  - N_Dot_L, 0.0 , 1.0);
            normalOffsetScale *= abs((shadowVertexEye.z - shadowDepthRange.x) * invDepthRange);
            normalOffsetScale *= max(shadowProjection.x, shadowProjection.y);
            normalOffsetScale *= normalBias * invDepthRange;


            vec4 shadowNormalShift =  vec4(normalWorld, 0.0) * normalOffsetScale;
            shadowNormalEye.x = dot(shadowViewRight.xyz, shadowNormalShift.xyz);
            shadowNormalEye.y = dot(shadowViewUp.xyz, shadowNormalShift.xyz);
            shadowNormalEye.z = dot(shadowViewLook.xyz, shadowNormalShift.xyz);
            shadowNormalEye.w = 0.0;

            vec4 viewShadow = shadowVertexEye + shadowNormalEye;
#else
            vec4 viewShadow = shadowVertexEye;
#endif


            if (shadowProjection.z == 0.0){

               // X, 0, 0, 0,
               // 0, Y, 0, 0,
               // 0, 0, -1, -1,
               // 0, 0, -2.0*znear, 0
               // mat4 shadowProjectionMatrix;
               // shadowProjectionMatrix[0] = vec4(shadowProjection.x, 0.0, 0.0, 0.0 );
               // shadowProjectionMatrix[1] = vec4(0.0, shadowProjection.y, 0.0, 0.0 );
               // shadowProjectionMatrix[2] = vec4(0.0, 0.0, -1.0, -1.0 );
               // shadowProjectionMatrix[3] = vec4(0.0, 0.0, -2.0*shadowDepthRange.x, 0.0 );
               // shadowVertexProjected = shadowProjectionMatrix * shadowVertexEye;

               // derivated optimisation
               shadowVertexProjected.x = shadowProjection.x * viewShadow.x;
               shadowVertexProjected.y = shadowProjection.y * viewShadow.y;

               shadowVertexProjected.z = - viewShadow.z - (2.0 * shadowDepthRange.x * viewShadow.w);
               shadowVertexProjected.w = - viewShadow.z;

            }
            else{
                // lr = 1/(left-right);
                // bt = 1/(bottom-top);
                // nf = 1/(near-far);
                // -2*lr,           0,               0,              0,
                // 0,               -2*bt,           0,              0,
                // 0,               0,               2*nf,           0.0,
                // (left+right)*lr, (top+bottom)*bt, (far+near)*nf), 1
                // here left = -right && top = -bottom
                // float lr = 1.0 / (-2.0 * shadowProjection.x);
                // float bt = 1.0 / (-2.0 * shadowProjection.y);
                // float nf = 1.0 / (shadowDepthRange.x - shadowDepthRange.y);
                float nfNeg = 1.0 / (shadowDepthRange.x - shadowDepthRange.y);
                float nfPos = (shadowDepthRange.x + shadowDepthRange.y)*nfNeg;

                //mat4 shadowProjectionMatrix;
                //shadowProjectionMatrix[0] = vec4(1.0 / shadowProjection.x, 0.0,     0.0,  0.0 );
                //shadowProjectionMatrix[1] = vec4(0.0,     1.0 / shadowProjection.y, 0.0,  0.0 );
                //shadowProjectionMatrix[2] = vec4(0.0,     0.0, 2.0*nfNeg, 0.0 );
                //shadowProjectionMatrix[3] = vec4(0.0,     0.0, nfPos, 1.0 );
                //shadowdertexProjected = shadowProjectionMatrix * shadowVertexEye;

                // derivated optimisation
                shadowVertexProjected.x = viewShadow.x / shadowProjection.x;
                shadowVertexProjected.y = viewShadow.y / shadowProjection.y;

                shadowVertexProjected.z = 2.0 * nfNeg* viewShadow.z + nfPos * viewShadow.w;
                shadowVertexProjected.w = viewShadow.w;

            }


            if (shadowVertexProjected.w < 0.0) {
                earlyOut = true; // notably behind camera
                dbgReason = 2.0;
            }

        }

        if (!earlyOut) {

            // Binary diagnosis toggles (window.SHADOW_RXDEBUG):
            //   13 -> disable the light-UV (XY footprint) cut, clamp UV instead
            //   14 -> disable the near-plane cut
            //   15 -> disable the far-plane cut
            // If the truncation disappears with one of these, that cut is the cause.
            bool noUVCut = debugRegion > 12.5 && debugRegion < 13.5;
            bool noNearCut = debugRegion > 13.5 && debugRegion < 14.5;
            bool noFarCut = debugRegion > 14.5 && debugRegion < 15.5;

            shadowUV.xy = shadowVertexProjected.xy / shadowVertexProjected.w;
            shadowUV.xy = shadowUV.xy * 0.5 + 0.5;// mad like

            if (any(bvec4 ( shadowUV.x > 1., shadowUV.x < 0., shadowUV.y > 1., shadowUV.y < 0.))) {
                if (noUVCut) {
                    shadowUV.xy = clamp(shadowUV.xy, 0.0, 1.0);
                } else {
                    earlyOut = true;// limits of light frustum
                    dbgReason = 3.0;
                }
            }

            // Radial (circular) fade toward the region edge instead of the square
            // max() metric, so the bounded boundary reads as a soft curve rather
            // than a straight axis-aligned line (the "straight limit" between
            // shadowed and unshadowed terrain). Kept fairly tight because
            // foreground objects sit near the frustum-slice sphere edge and a wide
            // fade would drop their shadows.
            float fadeRadial = length(shadowUV * 2.0 - 1.0);
            shadowFade = 1.0 - smoothstep(0.92, 1.0, fadeRadial);

            // most precision near 0, make sure we are near 0 and in [0,1]
            shadowReceiverZ = - shadowVertexEye.z;
            shadowReceiverZ =  (shadowReceiverZ - shadowDepthRange.x) * invDepthRange;

            // Fade out as the receiver approaches the far plane of the bounded
            // region. Just inside the far cutoff the caster depth map may not cover
            // the fragment, so it over-shadows into a thin dark band right before
            // the hard earlyOut below; fading avoids that seam.
            shadowFade = min(shadowFade, 1.0 - smoothstep(0.9, 1.0, shadowReceiverZ));

            if(shadowReceiverZ < 0.0 && !noNearCut) {
                earlyOut = true; // notably behind camera (closer to light than region)
                dbgReason = 4.0;
            }

            // Beyond the far plane of the (bounded) shadow region: this fragment is
            // farther from the light than anything the shadow map covers, so it can
            // not be correctly tested against the caster depth map. Stock osgjs
            // clamped receiverZ to 1.0 and compared anyway, which forces such
            // fragments "behind" every caster texel and paints them uniformly black.
            // With a bounded (max-distance) shadow region that happens en masse to
            // all terrain outside the region -- e.g. when looking down from above,
            // the region is fit to the near view slice (empty air) and the whole
            // distant terrain reads as over-shadowed (the "dark square"). Treat
            // out-of-range receivers as un-shadowed instead.
            if(shadowReceiverZ > 1.0 && !noFarCut) {
                earlyOut = true; // beyond the shadow region: no shadow here
                dbgReason = 5.0;
            }
            if (noFarCut) {
                shadowFade = 1.0; // don't fade either, so the extension is obvious
            }

        }
    }

    // pcf pbias to add on offset
    vec2 shadowBiasPCF = vec2 (0.);

#ifdef GL_OES_standard_derivatives
#ifdef _RECEIVERPLANEDEPTHBIAS
    vec2 biasUV;

    vec3 texCoordDY = dFdx(shadowVertexEye.xyz);
    vec3 texCoordDX = dFdy(shadowVertexEye.xyz);

    biasUV.x = texCoordDY.y * texCoordDX.z - texCoordDX.y * texCoordDY.z;
    biasUV.y = texCoordDX.x * texCoordDY.z - texCoordDY.x * texCoordDX.z;
    biasUV *= 1.0 / ((texCoordDX.x * texCoordDY.y) - (texCoordDX.y * texCoordDY.x));

    // Static depth biasing to make up for incorrect fractional sampling on the shadow map grid
    float fractionalSamplingError = dot(vec2(1.0, 1.0) * shadowSize.xy, abs(biasUV));
    float receiverDepthBias = min(fractionalSamplingError, 0.01);

    shadowBiasPCF.x = biasUV.x;
    shadowBiasPCF.y = biasUV.y;

    shadowReceiverZ += receiverDepthBias;

#else // _RECEIVERPLANEDEPTHBIAS
    shadowBiasPCF.x = clamp(dFdx(shadowReceiverZ) * shadowSize.x, -1.0, 1.0 );
    shadowBiasPCF.y = clamp(dFdy(shadowReceiverZ) * shadowSize.y, -1.0, 1.0 );
#endif

#endif // GL_OES_standard_derivatives


    vec4 clampDimension;

#ifdef _ATLAS_SHADOW
    shadowUV.xy  = ((shadowUV.xy * atlasSize.zw ) + atlasSize.xy) * shadowSize.xy;

    // clamp uv bias/filters by half pixel to avoid point filter on border
    clampDimension.xy = atlasSize.xy + vec2(0.5);
    clampDimension.zw = (atlasSize.xy + atlasSize.zw) - vec2(0.5);

    clampDimension = clampDimension * shadowSize.xyxy;
#else
    clampDimension = vec4(0.0, 0.0, 1.0, 1.0);
#endif // _RECEIVERPLANEDEPTHBIAS


    // now that derivatives is done and we don't access any mipmapped/texgrad texture we can early out
    // see http://teknicool.tumblr.com/post/77263472964/glsl-dynamic-branching-and-texture-samplers
    if (earlyOut) {
        // empty statement because of weird gpu intel bug
    } else {

        // Depth bias referenced to the shadow-map TEXEL size, not the (large,
        // bounded) depth range. The stock bias was a normalized value multiplied
        // by the depth range in the compare, so on a large bounded region
        // (range ~300m) even a small normalized bias became a big world-space push
        // ALONG the light -> the shadow detached from its caster (peter-panning),
        // worse at low sun. Here we build a small, near-constant WORLD offset
        // (~one shadow texel) and normalize it by the range only at the end, so the
        // world push stays tiny regardless of range. Grazing-angle acne is handled
        // by the range-independent normal-offset bias instead (see _NORMAL_OFFSET),
        // which shifts the sample along the surface normal and so does not detach
        // the shadow.
        float worldTexel = 2.0 * shadowProjection.x * shadowSize.x; // world units / texel
        // Slope-scaled: on grazing surfaces (surface nearly parallel to the light,
        // N_Dot_L small) the receiver depth changes by ~worldTexel*tan(angle) across
        // one shadow texel, so a constant bias leaves a periodic stripe of acne.
        // Add a tan(angle) term, but keep it texel-referenced and capped so the
        // along-light push (peter-panning) stays bounded regardless of sun angle.
        float slopeTan = sqrt(1.0 - N_Dot_L * N_Dot_L) / clamp(N_Dot_L, 0.1, 1.0);
        // shadowBias is repurposed as the base depth bias in TEXELS (live-tunable
        // via setBias; see Viewer.js shadow keys). Constant base + slope term,
        // capped a few texels above the base so peter-panning stays bounded.
        float worldBias = worldTexel * (shadowBias + slopeTan);
        worldBias = min(worldBias, worldTexel * (shadowBias + 3.0));
        float depthBias = worldBias * invDepthRange;

        // shadowZ must be clamped to [0,1]
        // otherwise it's not comparable to shadow caster depth map
        // which is clamped to [0,1]
        // Not doing that makes ALL shadowReceiver > 1.0 black
        // because they ALL becomes behind any point in Caster depth map
        shadowReceiverZ = clamp(shadowReceiverZ, 0.0, 1.0 -depthBias) - depthBias;

        // Now computes Shadow
        float res = getShadowPCF(shadowTexture,
                                 shadowSize,
                                 shadowUV,
                                 shadowReceiverZ,
                                 shadowBiasPCF,
                                 clampDimension
                                 OPT_INSTANCE_ARG_outDistance
                                 OPT_INSTANCE_ARG_jitter);

        // Caster-side diagnosis (window.SHADOW_RXDEBUG):
        //   21 -> show the RAW PCF compare result (before the snap/fade) as
        //         grayscale: dark = shadow present in the map, white = no occluder.
        //         If a truncated tree-shadow area is WHITE here, the caster itself
        //         is missing there; if it's DARK, something downstream removes it.
        //   22 -> disable the "snap faint shadow to lit" remap below.
        if (debugRegion > 20.5 && debugRegion < 21.5) {
            return res;
        }
        bool noSnap = debugRegion > 21.5 && debugRegion < 22.5;

        // Snap faint partial-shadowing up to fully lit. Inside the bounded region
        // even open, un-occluded terrain returns res slightly below 1.0 (PCF
        // filtering + micro-relief self-shadowing), so the whole region reads
        // subtly darker than the untouched exterior -- visible as an unnatural
        // "shadowed patch" that follows the camera when flying. Remapping
        // [0, threshold] -> [0, 1] forces any res at/above the threshold to exactly
        // 1.0 (fully lit) so only genuine shadows (res well below threshold) darken
        // the ground, while a soft gradient is kept below the threshold for real
        // penumbrae. shadowBias-independent, so it does not affect contact/acne.
        if (!noSnap) {
            res = smoothstep(0.0, 0.85, res);
        }
#ifdef _OUT_DISTANCE
        shadow = mix(1.0, res, shadowFade);
        outDistance *= shadowDepthRange.y - shadowDepthRange.x; // world space distance
#else
        shadow = res;
        shadow = mix(1.0, shadow, shadowFade);
#endif  // _OUT_DISTANCE
    }

    // SHADOW_RXDEBUG isolation: set window.SHADOW_RXDEBUG to a reason code and the
    // whole scene renders FULLY LIT (white) except fragments cut for that exact
    // reason, which render PURE BLACK -- maximum contrast so the truncation cause
    // is unmistakable in a screenshot. Reasons:
    //   3 = outside light UV (XY footprint edge)
    //   4 = before near plane (closer to light than region)
    //   5 = beyond far plane (farther from light than region)
    //   1 = no casters at all,  2 = behind camera
    // Legacy grayscale (all-reasons) view kept on SHADOW_RXDEBUG = 9.
    if (debugRegion > 0.5 && debugRegion < 12.5) {
        float sel = floor(debugRegion + 0.5);
        if (sel == 9.0) {
            if (dbgReason == 3.0) return 0.10;
            if (dbgReason == 5.0) return 0.35;
            if (dbgReason == 4.0) return 0.85;
            if (dbgReason == 1.0) return 0.60;
            if (dbgReason == 2.0) return 0.20;
            return shadow;
        }
        return dbgReason == sel ? 0.0 : 1.0;
    }

    return shadow;

}
