/* =============================================================================
   tripcam.js — REAL-TIME WebGL GLITCH ENGINE  (ported from "TAKE A TRIP")
   -----------------------------------------------------------------------------
   This is the ACTUAL shader engine from your working TAKE A TRIP app — all 11
   fragment shaders, verbatim, including the ping-pong frame-feedback buffer
   (u_previousFrameTexture) that gives it real temporal feedback on the GPU.

   Two jobs:
     1. Powers the Editor's ⚡ Live preview — drag a slider, see it at 60fps.
        The 5-to-30-second ffmpeg feedback loop dies.
     2. Powers the Trip Cam tab — webcam / screen / media-bin file → real-time
        glitch → RECORD → the clip lands straight in the Media Bin, where any of
        the 180 ffmpeg workflows can chew on it.

        Capture → mangle → master, in one app.
   ========================================================================== */

(function () {
  'use strict';

  const VERT = ` attribute vec4 a_position; attribute vec2 a_texCoord; varying vec2 v_texCoord; void main() { gl_Position = a_position; v_texCoord = a_texCoord; } `;

  const SHADERS = {
    'datamosh': `
            precision highp float; varying vec2 v_texCoord;
            uniform sampler2D u_webcamTexture; uniform sampler2D u_previousFrameTexture;
            uniform float u_time; uniform float u_motionThreshold; uniform float u_trailPersistence;
            uniform float u_hueShiftSpeed; uniform float u_motionExtrapolation;
            uniform float u_intensity; uniform float u_displacement; uniform float u_feedback;
            uniform float u_brightness; uniform float u_contrast; uniform float u_saturation;
            
            float random (vec2 st) { return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123 + u_time * 0.01); }
            float noise (vec2 st) { vec2 i = floor(st); vec2 f = fract(st); float a = random(i); float b = random(i + vec2(1.,0.)); float c = random(i + vec2(0.,1.)); float d = random(i + vec2(1.,1.)); vec2 u = f*f*(3.0-2.0*f); return mix(a, b, u.x) + (c - a)* u.y * (1.0 - u.x) + (d - b) * u.x * u.y; }
            vec3 rgb2hsl(vec3 color) { float r = color.r; float g = color.g; float b = color.b; float maxC = max(max(r, g), b); float minC = min(min(r, g), b); float h = 0.0, s = 0.0, l = (maxC + minC) / 2.0; if (maxC == minC) { h = s = 0.0; } else { float d = maxC - minC; s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC); if (maxC == r) { h = (g - b) / d + (g < b ? 6.0 : 0.0); } else if (maxC == g) { h = (b - r) / d + 2.0; } else if (maxC == b) { h = (r - g) / d + 4.0; } h /= 6.0; } return vec3(h, s, l); }
            float hue2rgb(float p, float q, float t) { if(t < 0.0) t += 1.0; if(t > 1.0) t -= 1.0; if(t < 1.0/6.0) return p + (q - p) * 6.0 * t; if(t < 1.0/2.0) return q; if(t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0; return p; }
            vec3 hsl2rgb(vec3 hsl) { float h = hsl.x; float s = hsl.y; float l = hsl.z; float r, g, b; if(s == 0.0){ r = g = b = l; } else { float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s; float p = 2.0 * l - q; r = hue2rgb(p, q, h + 1.0/3.0); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1.0/3.0); } return vec3(r, g, b); }
            
            vec3 adjustBrightnessContrast(vec3 color, float brightness, float contrast) {
                vec3 result = color + brightness;
                result = (result - 0.5) * contrast + 0.5;
                return clamp(result, 0.0, 1.0);
            }
            
            vec3 adjustSaturation(vec3 color, float saturation) {
                vec3 gray = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
                return mix(gray, color, saturation);
            }
            
            void main() {
                vec2 mirroredTexCoord = vec2(1.0 - v_texCoord.x, v_texCoord.y);
                vec4 currentWebcamColor = texture2D(u_webcamTexture, mirroredTexCoord);
                vec4 previousOrStaticColor = texture2D(u_previousFrameTexture, v_texCoord);
                float difference = length(currentWebcamColor.rgb - previousOrStaticColor.rgb);
                vec4 finalColor; vec4 motionDerivedColor; vec4 staticDerivedColor;
                
                // Enhanced displacement with intensity parameter
                float displacementAmount = u_displacement * (1.0 + u_intensity * 2.0);
                vec2 R_offset = vec2(random(mirroredTexCoord.yx + u_time * 0.1) - 0.5) * displacementAmount;
                vec2 B_offset = vec2(random(mirroredTexCoord.xy - u_time * 0.1) - 0.5) * displacementAmount;
                
                motionDerivedColor = vec4(
                    texture2D(u_webcamTexture, mirroredTexCoord + R_offset).r, 
                    currentWebcamColor.g, 
                    texture2D(u_webcamTexture, mirroredTexCoord + B_offset).b, 
                    1.0
                );
                
                // Enhanced smear with feedback
                vec2 smearOffset = vec2(noise(v_texCoord*8.0 + u_time*0.05)-0.5) * 0.003 * (1.0 + u_feedback * 3.0);
                vec4 smearedPreviousOrStatic = texture2D(u_previousFrameTexture, v_texCoord + smearOffset);
                
                // Trail persistence adjusted by intensity
                float adjustedTrailPersistence = clamp(u_trailPersistence * (1.0 + u_intensity * 0.5), 0.0, 1.0);
                staticDerivedColor = mix(currentWebcamColor, smearedPreviousOrStatic, clamp(adjustedTrailPersistence, 0.0, 100.0));
                
                if (difference > u_motionThreshold) {
                    finalColor = mix(staticDerivedColor, motionDerivedColor, 0.85 * (1.0 + u_intensity * 0.3));
                } else {
                    finalColor = staticDerivedColor;
                }
                
                if (u_motionExtrapolation > 0.0) {
                    vec2 pseudoVelocityOffset = vec2(noise(v_texCoord*8.0 + u_time*0.05)-0.5) * 0.003 * (1.0 + u_feedback);
                    vec2 extrapolatedCoord = v_texCoord + pseudoVelocityOffset * u_motionExtrapolation;
                    vec4 extrapolatedColor = texture2D(u_previousFrameTexture, extrapolatedCoord);
                    float extrapolationMix = u_motionExtrapolation * smoothstep(u_motionThreshold + 0.05, u_motionThreshold - 0.05, difference);
                    extrapolationMix = clamp(extrapolationMix, 0.0, 0.9);
                    finalColor = mix(finalColor, extrapolatedColor, extrapolationMix);
                }
                
                if (u_hueShiftSpeed != 0.0) {
                    vec3 hsl = rgb2hsl(finalColor.rgb);
                    hsl.x = fract(hsl.x + u_time * u_hueShiftSpeed);
                    if (hsl.y < 0.1) { hsl.y = 0.7; }
                    finalColor.rgb = hsl2rgb(hsl);
                }
                
                // Apply brightness, contrast, and saturation adjustments
                finalColor.rgb = adjustSaturation(
                    adjustBrightnessContrast(finalColor.rgb, u_brightness, u_contrast),
                    u_saturation
                );
                
                finalColor = clamp(finalColor, 0.0, 1.0);
                if (finalColor.a < 0.01) discard;
                gl_FragColor = finalColor;
            }`,
    'pixelsort': `
            precision highp float; varying vec2 v_texCoord;
            uniform sampler2D u_webcamTexture; uniform sampler2D u_previousFrameTexture;
            uniform float u_time; uniform float u_motionThreshold; uniform float u_trailPersistence;
            uniform float u_hueShiftSpeed; uniform float u_motionExtrapolation;
            uniform float u_intensity; uniform float u_displacement; uniform float u_feedback;
            uniform float u_threshold; uniform float u_brightness; uniform float u_contrast; uniform float u_saturation;
            
            float random (vec2 st) { return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123 + u_time * 0.01); }
            float noise (vec2 st) { vec2 i = floor(st); vec2 f = fract(st); float a = random(i); float b = random(i + vec2(1.,0.)); float c = random(i + vec2(0.,1.)); float d = random(i + vec2(1.,1.)); vec2 u = f*f*(3.0-2.0*f); return mix(a, b, u.x) + (c - a)* u.y * (1.0 - u.x) + (d - b) * u.x * u.y; }
            vec3 rgb2hsl(vec3 color) { float r = color.r; float g = color.g; float b = color.b; float maxC = max(max(r, g), b); float minC = min(min(r, g), b); float h = 0.0, s = 0.0, l = (maxC + minC) / 2.0; if (maxC == minC) { h = s = 0.0; } else { float d = maxC - minC; s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC); if (maxC == r) { h = (g - b) / d + (g < b ? 6.0 : 0.0); } else if (maxC == g) { h = (b - r) / d + 2.0; } else if (maxC == b) { h = (r - g) / d + 4.0; } h /= 6.0; } return vec3(h, s, l); }
            float hue2rgb(float p, float q, float t) { if(t < 0.0) t += 1.0; if(t > 1.0) t -= 1.0; if(t < 1.0/6.0) return p + (q - p) * 6.0 * t; if(t < 1.0/2.0) return q; if(t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0; return p; }
            vec3 hsl2rgb(vec3 hsl) { float h = hsl.x; float s = hsl.y; float l = hsl.z; float r, g, b; if(s == 0.0){ r = g = b = l; } else { float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s; float p = 2.0 * l - q; r = hue2rgb(p, q, h + 1.0/3.0); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1.0/3.0); } return vec3(r, g, b); }
            
            vec3 adjustBrightnessContrast(vec3 color, float brightness, float contrast) {
                vec3 result = color + brightness;
                result = (result - 0.5) * contrast + 0.5;
                return clamp(result, 0.0, 1.0);
            }
            
            vec3 adjustSaturation(vec3 color, float saturation) {
                vec3 gray = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
                return mix(gray, color, saturation);
            }
            
            void main() {
                vec2 mirroredTexCoord = vec2(1.0 - v_texCoord.x, v_texCoord.y);
                vec4 currentWebcamColor = texture2D(u_webcamTexture, mirroredTexCoord);
                vec4 previousOrStaticColor = texture2D(u_previousFrameTexture, v_texCoord);
                
                float brightness = dot(currentWebcamColor.rgb, vec3(0.299, 0.587, 0.114));
                
                // Pixel sort based on brightness threshold and direction
                vec2 sortDir = vec2(0.0, 1.0); // Sort vertically
                if (sin(u_time * 0.1) > 0.0) {
                    sortDir = vec2(1.0, 0.0); // Sometimes sort horizontally
                }
                
                // Adjust threshold based on intensity
                float adjustedThreshold = u_threshold * (1.0 + u_intensity * 0.5);
                
                // Sort pixel if brightness meets threshold
                vec2 sortedCoord = mirroredTexCoord;
                if (brightness > adjustedThreshold) {
                    // Offset in the sort direction
                    sortedCoord += sortDir * u_displacement * 10.0 * (brightness - adjustedThreshold);
                    sortedCoord = fract(sortedCoord); // Wrap around
                }
                
                vec4 sortedColor = texture2D(u_webcamTexture, sortedCoord);
                
                // Mix with previous frame for trails
                vec4 finalColor = mix(sortedColor, previousOrStaticColor, u_trailPersistence);
                
                // Apply feedback effect
                if (u_feedback > 0.0) {
                    vec2 feedbackOffset = vec2(noise(v_texCoord*3.0 + u_time*0.1)-0.5) * 0.01 * u_feedback;
                    vec4 feedbackColor = texture2D(u_previousFrameTexture, v_texCoord + feedbackOffset);
                    finalColor = mix(finalColor, feedbackColor, u_feedback * 0.5);
                }
                
                // Apply hue shift if enabled
                if (u_hueShiftSpeed != 0.0) {
                    vec3 hsl = rgb2hsl(finalColor.rgb);
                    hsl.x = fract(hsl.x + u_time * u_hueShiftSpeed);
                    finalColor.rgb = hsl2rgb(hsl);
                }
                
                // Apply brightness, contrast, and saturation adjustments
                finalColor.rgb = adjustSaturation(
                    adjustBrightnessContrast(finalColor.rgb, u_brightness, u_contrast),
                    u_saturation
                );
                
                finalColor = clamp(finalColor, 0.0, 1.0);
                gl_FragColor = finalColor;
            }`,
    'feedback': `
            precision highp float; varying vec2 v_texCoord;
            uniform sampler2D u_webcamTexture; uniform sampler2D u_previousFrameTexture;
            uniform float u_time; uniform float u_motionThreshold; uniform float u_trailPersistence;
            uniform float u_hueShiftSpeed; uniform float u_motionExtrapolation;
            uniform float u_intensity; uniform float u_displacement; uniform float u_feedback;
            uniform float u_threshold; uniform float u_brightness; uniform float u_contrast; uniform float u_saturation;
            
            float random (vec2 st) { return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123 + u_time * 0.01); }
            float noise (vec2 st) { vec2 i = floor(st); vec2 f = fract(st); float a = random(i); float b = random(i + vec2(1.,0.)); float c = random(i + vec2(0.,1.)); float d = random(i + vec2(1.,1.)); vec2 u = f*f*(3.0-2.0*f); return mix(a, b, u.x) + (c - a)* u.y * (1.0 - u.x) + (d - b) * u.x * u.y; }
            vec3 rgb2hsl(vec3 color) { float r = color.r; float g = color.g; float b = color.b; float maxC = max(max(r, g), b); float minC = min(min(r, g), b); float h = 0.0, s = 0.0, l = (maxC + minC) / 2.0; if (maxC == minC) { h = s = 0.0; } else { float d = maxC - minC; s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC); if (maxC == r) { h = (g - b) / d + (g < b ? 6.0 : 0.0); } else if (maxC == g) { h = (b - r) / d + 2.0; } else if (maxC == b) { h = (r - g) / d + 4.0; } h /= 6.0; } return vec3(h, s, l); }
            float hue2rgb(float p, float q, float t) { if(t < 0.0) t += 1.0; if(t > 1.0) t -= 1.0; if(t < 1.0/6.0) return p + (q - p) * 6.0 * t; if(t < 1.0/2.0) return q; if(t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0; return p; }
            vec3 hsl2rgb(vec3 hsl) { float h = hsl.x; float s = hsl.y; float l = hsl.z; float r, g, b; if(s == 0.0){ r = g = b = l; } else { float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s; float p = 2.0 * l - q; r = hue2rgb(p, q, h + 1.0/3.0); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1.0/3.0); } return vec3(r, g, b); }
            
            vec3 adjustBrightnessContrast(vec3 color, float brightness, float contrast) {
                vec3 result = color + brightness;
                result = (result - 0.5) * contrast + 0.5;
                return clamp(result, 0.0, 1.0);
            }
            
            vec3 adjustSaturation(vec3 color, float saturation) {
                vec3 gray = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
                return mix(gray, color, saturation);
            }
            
            void main() {
                vec2 mirroredTexCoord = vec2(1.0 - v_texCoord.x, v_texCoord.y);
                
                // Create feedback effect by rotating/zooming coordinates
                float angle = u_time * 0.05 * u_intensity;
                float zoom = 1.0 + sin(u_time * 0.1) * 0.01 * u_intensity;
                
                vec2 center = vec2(0.5, 0.5);
                vec2 fbCoord = v_texCoord - center;
                fbCoord = vec2(
                    fbCoord.x * cos(angle) - fbCoord.y * sin(angle),
                    fbCoord.x * sin(angle) + fbCoord.y * cos(angle)
                );
                fbCoord = fbCoord * zoom + center;
                
                // Add displacement/warp for more organic feel
                fbCoord += vec2(
                    noise(fbCoord * 5.0 + u_time * 0.1) - 0.5,
                    noise(fbCoord * 5.0 - u_time * 0.1) - 0.5
                ) * u_displacement * 0.1;
                
                vec4 currentWebcamColor = texture2D(u_webcamTexture, mirroredTexCoord);
                vec4 feedbackColor = texture2D(u_previousFrameTexture, fbCoord);
                
                // Blend webcam with feedback based on our parameters
                float feedbackAmount = clamp(u_feedback * (1.0 + u_intensity), 0.0, 0.95);
                vec4 finalColor = mix(currentWebcamColor, feedbackColor, feedbackAmount);
                
                // Add some motion-reactive glow
                float difference = length(currentWebcamColor.rgb - feedbackColor.rgb);
                if (difference > u_motionThreshold) {
                    // Enhance colors where motion is detected
                    vec3 hsl = rgb2hsl(finalColor.rgb);
                    hsl.y = min(hsl.y + 0.2 * u_intensity, 1.0);  // Increase saturation
                    hsl.z = min(hsl.z + 0.1 * u_intensity, 0.9);  // Increase lightness
                    finalColor.rgb = hsl2rgb(hsl);
                }
                
                // Apply hue shift if enabled
                if (u_hueShiftSpeed != 0.0) {
                    vec3 hsl = rgb2hsl(finalColor.rgb);
                    hsl.x = fract(hsl.x + u_time * u_hueShiftSpeed);
                    finalColor.rgb = hsl2rgb(hsl);
                }
                
                // Apply brightness, contrast, and saturation adjustments
                finalColor.rgb = adjustSaturation(
                    adjustBrightnessContrast(finalColor.rgb, u_brightness, u_contrast),
                    u_saturation
                );
                
                finalColor = clamp(finalColor, 0.0, 1.0);
                gl_FragColor = finalColor;
            }`,
    'colorshift': `
            precision highp float; varying vec2 v_texCoord;
            uniform sampler2D u_webcamTexture; uniform sampler2D u_previousFrameTexture;
            uniform float u_time; uniform float u_motionThreshold; uniform float u_trailPersistence;
            uniform float u_hueShiftSpeed; uniform float u_motionExtrapolation;
            uniform float u_intensity; uniform float u_displacement; uniform float u_feedback;
            uniform float u_threshold; uniform float u_brightness; uniform float u_contrast; uniform float u_saturation;
            
            float random (vec2 st) { return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123 + u_time * 0.01); }
            float noise (vec2 st) { vec2 i = floor(st); vec2 f = fract(st); float a = random(i); float b = random(i + vec2(1.,0.)); float c = random(i + vec2(0.,1.)); float d = random(i + vec2(1.,1.)); vec2 u = f*f*(3.0-2.0*f); return mix(a, b, u.x) + (c - a)* u.y * (1.0 - u.x) + (d - b) * u.x * u.y; }
            vec3 rgb2hsl(vec3 color) { float r = color.r; float g = color.g; float b = color.b; float maxC = max(max(r, g), b); float minC = min(min(r, g), b); float h = 0.0, s = 0.0, l = (maxC + minC) / 2.0; if (maxC == minC) { h = s = 0.0; } else { float d = maxC - minC; s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC); if (maxC == r) { h = (g - b) / d + (g < b ? 6.0 : 0.0); } else if (maxC == g) { h = (b - r) / d + 2.0; } else if (maxC == b) { h = (r - g) / d + 4.0; } h /= 6.0; } return vec3(h, s, l); }
            float hue2rgb(float p, float q, float t) { if(t < 0.0) t += 1.0; if(t > 1.0) t -= 1.0; if(t < 1.0/6.0) return p + (q - p) * 6.0 * t; if(t < 1.0/2.0) return q; if(t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0; return p; }
            vec3 hsl2rgb(vec3 hsl) { float h = hsl.x; float s = hsl.y; float l = hsl.z; float r, g, b; if(s == 0.0){ r = g = b = l; } else { float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s; float p = 2.0 * l - q; r = hue2rgb(p, q, h + 1.0/3.0); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1.0/3.0); } return vec3(r, g, b); }
            
            vec3 adjustBrightnessContrast(vec3 color, float brightness, float contrast) {
                vec3 result = color + brightness;
                result = (result - 0.5) * contrast + 0.5;
                return clamp(result, 0.0, 1.0);
            }
            
            vec3 adjustSaturation(vec3 color, float saturation) {
                vec3 gray = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
                return mix(gray, color, saturation);
            }
            
            void main() {
                vec2 mirroredTexCoord = vec2(1.0 - v_texCoord.x, v_texCoord.y);
                
                // Create color channel separation effect
                float channelShift = u_displacement * 0.2 * (1.0 + u_intensity);
                vec2 rOffset = vec2(sin(u_time * 0.3) * channelShift, cos(u_time * 0.2) * channelShift);
                vec2 gOffset = vec2(sin(u_time * 0.2 + 2.0) * channelShift, cos(u_time * 0.3 + 1.0) * channelShift);
                vec2 bOffset = vec2(sin(u_time * 0.1 + 4.0) * channelShift, cos(u_time * 0.4 + 3.0) * channelShift);
                
                // Sample each color channel with offset
                float r = texture2D(u_webcamTexture, mirroredTexCoord + rOffset).r;
                float g = texture2D(u_webcamTexture, mirroredTexCoord + gOffset).g;
                float b = texture2D(u_webcamTexture, mirroredTexCoord + bOffset).b;
                
                vec4 currentColor = vec4(r, g, b, 1.0);
                vec4 previousColor = texture2D(u_previousFrameTexture, v_texCoord);
                
                // Add trail/persistence
                vec4 finalColor = mix(currentColor, previousColor, u_trailPersistence);
                
                // Add some dynamic hue rotation
                float dynamicHueShift = u_hueShiftSpeed + sin(u_time * 0.1) * 0.02 * u_intensity;
                vec3 hsl = rgb2hsl(finalColor.rgb);
                
                // Make the hue shift more dramatic with intensity
                hsl.x = fract(hsl.x + u_time * dynamicHueShift);
                
                // Enhance saturation based on intensity
                hsl.y = min(hsl.y + u_intensity * 0.3, 1.0);
                
                finalColor.rgb = hsl2rgb(hsl);
                
                // Blend with feedback for more visual complexity
                if (u_feedback > 0.0) {
                    // Apply a slight zoom and rotation to the feedback
                    vec2 center = vec2(0.5, 0.5);
                    vec2 fbCoord = v_texCoord - center;
                    float angle = u_time * 0.02 * u_feedback;
                    fbCoord = vec2(
                        fbCoord.x * cos(angle) - fbCoord.y * sin(angle),
                        fbCoord.x * sin(angle) + fbCoord.y * cos(angle)
                    );
                    fbCoord = fbCoord * (1.0 + u_feedback * 0.03) + center;
                    
                    vec4 feedbackColor = texture2D(u_previousFrameTexture, fbCoord);
                    finalColor = mix(finalColor, feedbackColor, u_feedback * 0.5);
                }
                
                // Apply brightness, contrast, and saturation adjustments
                finalColor.rgb = adjustSaturation(
                    adjustBrightnessContrast(finalColor.rgb, u_brightness, u_contrast),
                    u_saturation
                );
                
                finalColor = clamp(finalColor, 0.0, 1.0);
                gl_FragColor = finalColor;
            }`,
    'crt': `
            precision highp float;
            varying vec2 v_texCoord;
            uniform sampler2D u_webcamTexture;
            uniform float u_time;
            uniform float u_brightness;
            uniform float u_contrast;
            uniform float u_saturation;
            uniform float u_intensity;

            uniform float u_scanlineIntensity;
            uniform float u_scanlineDensity;
            uniform float u_curvatureAmount;
            uniform float u_phosphorOffset;
            uniform float u_vignetteStrength;
            uniform float u_vignetteSoftness;

            vec3 adjustBrightnessContrast(vec3 color, float brightness, float contrast) {
                vec3 result = color + brightness;
                result = (result - 0.5) * contrast + 0.5;
                return clamp(result, 0.0, 1.0);
            }

            vec3 adjustSaturation(vec3 color, float saturation) {
                vec3 gray = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
                return mix(gray, color, saturation);
            }

            void main() {
                vec2 uv = v_texCoord;
                uv.x = 1.0 - uv.x; // Mirror webcam input

                // Screen Curvature (Barrel Distortion)
                vec2 centeredUV = uv * 2.0 - 1.0;
                float r_sq = dot(centeredUV, centeredUV);
                vec2 distortedUV = centeredUV * (1.0 - u_curvatureAmount * r_sq);
                distortedUV = (distortedUV + 1.0) * 0.5;

                vec4 finalColor = vec4(0.0, 0.0, 0.0, 1.0);

                if (distortedUV.x >= 0.0 && distortedUV.x <= 1.0 && distortedUV.y >= 0.0 && distortedUV.y <= 1.0) {
                    // Chromatic Aberration
                    vec2 r_offset = vec2(u_phosphorOffset, 0.0);
                    vec2 b_offset = vec2(-u_phosphorOffset, 0.0);
                    float r_channel = texture2D(u_webcamTexture, distortedUV + r_offset).r;
                    float g_channel = texture2D(u_webcamTexture, distortedUV).g;
                    float b_channel = texture2D(u_webcamTexture, distortedUV + b_offset).b;
                    finalColor = vec4(r_channel, g_channel, b_channel, 1.0);

                    // Scanlines
                    float scanlineEffect = sin(distortedUV.y * u_scanlineDensity * 3.1415926535 * 2.0); // Using PI for frequency
                    scanlineEffect = (scanlineEffect + 1.0) * 0.5; // Remap to 0-1
                    finalColor.rgb *= (1.0 - u_scanlineIntensity * (1.0 - scanlineEffect));
                }

                // Vignette
                float vignette = 1.0 - u_vignetteStrength * smoothstep(u_vignetteSoftness, 0.0, length(centeredUV * 1.414)); // 1.414 approx sqrt(2) for corners
                finalColor.rgb *= vignette;

                finalColor.rgb = adjustSaturation(
                    adjustBrightnessContrast(finalColor.rgb, u_brightness, u_contrast),
                    u_saturation
                );
                gl_FragColor = finalColor;
            }
        `,
    'mirror': `
precision highp float;
varying vec2 v_texCoord;
uniform sampler2D u_webcamTexture;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
// uniform float u_intensity; // Available but not used by this simple mirror

vec3 adjustBrightnessContrast(vec3 color, float brightness, float contrast) {
    vec3 result = color + brightness;
    result = (result - 0.5) * contrast + 0.5;
    return clamp(result, 0.0, 1.0);
}

vec3 adjustSaturation(vec3 color, float saturation) {
    vec3 gray = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
    return mix(gray, color, saturation);
}

void main() {
    // Most shaders use vec2(1.0 - v_texCoord.x, v_texCoord.y) to mirror webcam input.
    // This shader uses v_texCoord.x directly to show the NON-mirrored version,
    // thus appearing as a "Horizontal Mirror" relative to the other effects.
    vec4 finalColor = texture2D(u_webcamTexture, vec2(v_texCoord.x, v_texCoord.y));
    finalColor.rgb = adjustSaturation(adjustBrightnessContrast(finalColor.rgb, u_brightness, u_contrast),u_saturation);
    gl_FragColor = finalColor;
}`,
    'wavewarp': `
precision highp float; varying vec2 v_texCoord;
uniform sampler2D u_webcamTexture; uniform float u_time;
uniform float u_brightness; uniform float u_contrast; uniform float u_saturation; uniform float u_intensity;
uniform float u_waveDensity; uniform float u_waveSpeed; uniform float u_waveAmplitude;

vec3 adjustBrightnessContrast(vec3 color, float brightness, float contrast) {
    vec3 result = color + brightness;
    result = (result - 0.5) * contrast + 0.5;
    return clamp(result, 0.0, 1.0);
}

vec3 adjustSaturation(vec3 color, float saturation) {
    vec3 gray = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
    return mix(gray, color, saturation);
}

void main() {
    vec2 texCoord = vec2(1.0 - v_texCoord.x, v_texCoord.y); // Standard mirror
    float modulatedAmplitude = u_waveAmplitude * (0.5 + u_intensity * 0.5);
    texCoord.y += sin(texCoord.x * u_waveDensity + u_time * u_waveSpeed) * modulatedAmplitude;
    vec4 finalColor;
    if (texCoord.y < 0.0 || texCoord.y > 1.0 || texCoord.x < 0.0 || texCoord.x > 1.0) { finalColor = vec4(0.0,0.0,0.0,1.0); }
    else { finalColor = texture2D(u_webcamTexture, texCoord); }
    finalColor.rgb = adjustSaturation(adjustBrightnessContrast(finalColor.rgb, u_brightness, u_contrast), u_saturation);
    gl_FragColor = finalColor;
}`,
    'kaleidoscope': `
precision highp float; varying vec2 v_texCoord;
uniform sampler2D u_webcamTexture; uniform float u_time;
uniform float u_brightness; uniform float u_contrast; uniform float u_saturation; uniform float u_intensity;
uniform float u_kaleidoSegments;

vec3 adjustBrightnessContrast(vec3 color, float brightness, float contrast) {
    vec3 result = color + brightness;
    result = (result - 0.5) * contrast + 0.5;
    return clamp(result, 0.0, 1.0);
}

vec3 adjustSaturation(vec3 color, float saturation) {
    vec3 gray = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
    return mix(gray, color, saturation);
}

const float PI = 3.14159265359;
void main() {
    vec2 originalTexCoord = vec2(1.0 - v_texCoord.x, v_texCoord.y); // Standard mirror
    vec2 p = originalTexCoord - 0.5;
    float r = length(p); float angle = atan(p.y, p.x);
    float segments = max(2.0, floor(u_kaleidoSegments));
    float segmentAngleSlice = PI / segments;
    angle += u_time * 0.1 * (u_intensity - 0.5) * 2.0; // Intensity affects rotation speed/direction
    angle = mod(angle, segmentAngleSlice * 2.0);
    if (angle > segmentAngleSlice) { angle = (segmentAngleSlice * 2.0) - angle; }
    vec2 uvKaleido = vec2(r * cos(angle), r * sin(angle)) + 0.5;
    vec4 finalColor = texture2D(u_webcamTexture, uvKaleido);
    finalColor.rgb = adjustSaturation(adjustBrightnessContrast(finalColor.rgb, u_brightness, u_contrast), u_saturation);
    gl_FragColor = finalColor;
}`,
    'fisheye': `
precision highp float; varying vec2 v_texCoord;
uniform sampler2D u_webcamTexture; uniform float u_time;
uniform float u_brightness; uniform float u_contrast; uniform float u_saturation; uniform float u_intensity;
uniform float u_fisheyeStrength;

vec3 adjustBrightnessContrast(vec3 color, float brightness, float contrast) {
    vec3 result = color + brightness;
    result = (result - 0.5) * contrast + 0.5;
    return clamp(result, 0.0, 1.0);
}
vec3 adjustSaturation(vec3 color, float saturation) {
    vec3 gray = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
    return mix(gray, color, saturation);
}

void main() {
    vec2 texCoord = vec2(1.0 - v_texCoord.x, v_texCoord.y); // Standard mirror
    vec2 uv_centered = texCoord * 2.0 - 1.0;
    float d = length(uv_centered);
    if (d != 0.0) { // Avoid division by zero at center
        uv_centered = uv_centered / (1.0 + u_fisheyeStrength * d);
    }
    vec2 finalUV = (uv_centered + 1.0) / 2.0;
    vec4 finalColor;
    if (finalUV.x < 0.0 || finalUV.x > 1.0 || finalUV.y < 0.0 || finalUV.y > 1.0) { finalColor = vec4(0.0,0.0,0.0,1.0); }
    else { finalColor = texture2D(u_webcamTexture, finalUV); }
    finalColor.rgb = adjustSaturation(adjustBrightnessContrast(finalColor.rgb, u_brightness, u_contrast), u_saturation);
    gl_FragColor = finalColor;
}`,
    'noiseGlitch': `
precision highp float; varying vec2 v_texCoord;
uniform sampler2D u_webcamTexture; uniform float u_time;
uniform float u_brightness; uniform float u_contrast; uniform float u_saturation; uniform float u_intensity;
uniform float u_glitchStrength;

vec3 adjustBrightnessContrast(vec3 color, float brightness, float contrast) {
    vec3 result = color + brightness;
    result = (result - 0.5) * contrast + 0.5;
    return clamp(result, 0.0, 1.0);
}
vec3 adjustSaturation(vec3 color, float saturation) {
    vec3 gray = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
    return mix(gray, color, saturation);
}
float random (vec2 st) { return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123 + u_time * 0.1); }
float noise (vec2 st) { vec2 i=floor(st);vec2 f=fract(st);float a=random(i);float b=random(i+vec2(1.,0.));float c=random(i+vec2(0.,1.));float d=random(i+vec2(1.,1.));vec2 u=f*f*(3.-2.*f);return mix(a,b,u.x)+(c-a)*u.y*(1.-u.x)+(d-b)*u.x*u.y;}

void main() {
    vec2 texCoord = vec2(1.0 - v_texCoord.x, v_texCoord.y); // Standard mirror
    float actualGlitchStrength = u_glitchStrength * (0.5 + u_intensity * 0.5);
    vec4 finalColor = texture2D(u_webcamTexture, texCoord);
    if (random(vec2(texCoord.y * (10.0 + actualGlitchStrength * 20.0), u_time)) > (1.0 - actualGlitchStrength * 0.25)) {
        float slipOffset = (random(vec2(texCoord.y * 1.3, u_time * 1.1)) - 0.5) * 0.3;
        finalColor = texture2D(u_webcamTexture, vec2(fract(texCoord.x + slipOffset), texCoord.y));
    }
    if (actualGlitchStrength > 0.01) {
         float rNoise = (noise(texCoord * 50.0 + u_time * 2.0) - 0.5) * 0.1 * actualGlitchStrength;
         finalColor.r = fract(finalColor.r + rNoise);
    }
    finalColor.rgb = adjustSaturation(adjustBrightnessContrast(finalColor.rgb, u_brightness, u_contrast), u_saturation);
    gl_FragColor = clamp(finalColor, 0.0, 1.0);
}`,
    'feedbackDisplace': `
    precision highp float; // Changed to highp for consistency and potential precision needs
    varying vec2 v_texCoord;

    // u_webcamTexture (TEXTURE0) is the current live input
    // u_previousFrameTexture (TEXTURE1) is the output of the last frame, used here as the displacement map source
    uniform sampler2D u_webcamTexture;
    uniform sampler2D u_previousFrameTexture; // This will be used as the displacement map.
    // uniform sampler2D u_displacement_texture_feedback; // This is conceptually u_previousFrameTexture (TEXTURE1) for this effect.
                                                        // The actual uniform u_displacement_texture_feedback will be set to TEXTURE1 in drawScene.
    uniform float u_displacement_map_strength;
    uniform vec2 u_resolution;
    uniform float u_brightness; // Standard post-processing
    uniform float u_contrast;   // Standard post-processing
    uniform float u_saturation; // Standard post-processing
    uniform float u_intensity;  // To modulate displacement strength

    vec3 adjustBrightnessContrast(vec3 color, float brightness, float contrast) {
        vec3 result = color + brightness;
        result = (result - 0.5) * contrast + 0.5;
        return clamp(result, 0.0, 1.0);
    }

    vec3 adjustSaturation(vec3 color, float saturation) {
        vec3 gray = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
        return mix(gray, color, saturation);
    }

    void main() {
        // Sample the displacement map (using previous frame's output, which is on u_previousFrameTexture)
        vec4 displacementColor = texture2D(u_previousFrameTexture, v_texCoord);

        // Modulate displacement strength with intensity
        float actualDisplacementStrength = u_displacement_map_strength * (0.5 + u_intensity * 0.5);

        vec2 displacement = (displacementColor.rg * 2.0 - 1.0) * actualDisplacementStrength;
        // Optional: For pixel-based displacement, uncomment and ensure u_resolution is correctly passed
        // if (u_resolution.x > 0.0 && u_resolution.y > 0.0) {
        //     displacement = (displacementColor.rg * 2.0 - 1.0) * actualDisplacementStrength / u_resolution;
        // } else {
        //     displacement = (displacementColor.rg * 2.0 - 1.0) * actualDisplacementStrength * 0.01; // Fallback if resolution is 0
        // }

        // Standard mirroring for webcam input before displacement
        vec2 mirroredWebcamTexcoord = vec2(1.0 - v_texCoord.x, v_texCoord.y);
        vec2 displacedTexcoord = mirroredWebcamTexcoord + displacement;

        vec4 finalColor;
        // Boundary check after displacement
        if (displacedTexcoord.x < 0.0 || displacedTexcoord.x > 1.0 || displacedTexcoord.y < 0.0 || displacedTexcoord.y > 1.0) {
            finalColor = vec4(0.0, 0.0, 0.0, 1.0); // Output black if out of bounds
        } else {
            finalColor = texture2D(u_webcamTexture, displacedTexcoord);
        }

        finalColor.rgb = adjustSaturation(
            adjustBrightnessContrast(finalColor.rgb, u_brightness, u_contrast),
            u_saturation
        );
        gl_FragColor = finalColor;
    }
`,
  };

  const EFFECTS = [
    {
        "id": "datamosh",
        "label": "Datamosh"
    },
    {
        "id": "pixelsort",
        "label": "Pixel Sort"
    },
    {
        "id": "feedback",
        "label": "Feedback"
    },
    {
        "id": "colorshift",
        "label": "Color Shift"
    },
    {
        "id": "crt",
        "label": "CRT"
    },
    {
        "id": "mirror",
        "label": "Horizontal Mirror"
    },
    {
        "id": "wavewarp",
        "label": "Wave Warp"
    },
    {
        "id": "kaleidoscope",
        "label": "Kaleidoscope"
    },
    {
        "id": "fisheye",
        "label": "Fisheye"
    },
    {
        "id": "noiseGlitch",
        "label": "Noise Glitch"
    },
    {
        "id": "feedbackDisplace",
        "label": "Feedback Displace"
    }
];

  const PRESETS = {
              default: { trail: 0.9, motion: 0.12, hue: 0.0, history: 6, extrap: 0.0, intensity: 0.5, displacement: 0.01, feedback: 0.2, threshold: 0.5, brightness: 0.0, contrast: 1.0, saturation: 1.0 },
              psychedelic: { trail: 1.2, motion: 0.15, hue: 0.05, history: 8, extrap: 0.5, intensity: 0.8, displacement: 0.02, feedback: 0.4, threshold: 0.6, brightness: 0.05, contrast: 1.2, saturation: 1.4 },
              ghostly: { trail: 1.3, motion: 0.08, hue: 0.0, history: 12, extrap: 1.0, intensity: 0.3, displacement: 0.005, feedback: 0.6, threshold: 0.3, brightness: -0.1, contrast: 0.8, saturation: 0.7 },
              neon: { trail: 0.95, motion: 0.2, hue: 0.02, history: 4, extrap: 0.0, intensity: 0.9, displacement: 0.03, feedback: 0.1, threshold: 0.7, brightness: 0.1, contrast: 1.4, saturation: 1.6 },
              glitchy: { trail: 0.7, motion: 0.3, hue: -0.01, history: 3, extrap: 0.0, intensity: 0.7, displacement: 0.05, feedback: 0.05, threshold: 0.4, brightness: 0.0, contrast: 1.1, saturation: 1.2 },
              dreamy: { trail: 1.1, motion: 0.05, hue: 0.01, history: 10, extrap: 0.8, intensity: 0.4, displacement: 0.008, feedback: 0.5, threshold: 0.3, brightness: 0.0, contrast: 0.9, saturation: 0.9 }
          };

  // ===========================================================================
  // ENGINE
  // ===========================================================================

  const U = [
    'u_time','u_resolution','u_intensity','u_threshold','u_displacement','u_feedback',
    'u_trailPersistence','u_motionThreshold','u_motionExtrapolation','u_glitchStrength',
    'u_hueShiftSpeed','u_saturation','u_brightness','u_contrast','u_scanlineDensity',
    'u_scanlineIntensity','u_phosphorOffset','u_curvatureAmount','u_kaleidoSegments',
    'u_fisheyeStrength','u_waveAmplitude','u_waveDensity','u_waveSpeed',
    'u_vignetteStrength','u_vignetteSoftness','u_displacementStrength',
    'u_cameraRotation','u_displacementMapStrength',
    'u_audioBass','u_audioMid','u_audioTreble',
  ];

  const DEFAULTS = {
    intensity: 0.5, threshold: 0.5, displacement: 0.01, feedback: 0.2,
    trailPersistence: 0.9, motionThreshold: 0.12, motionExtrapolation: 0.0,
    glitchStrength: 0.3, hueShiftSpeed: 0.0, saturation: 1.0, brightness: 0.0,
    contrast: 1.0, scanlineDensity: 400, scanlineIntensity: 0.25,
    phosphorOffset: 0.002, curvatureAmount: 0.1, kaleidoSegments: 6,
    fisheyeStrength: 0.5, waveAmplitude: 0.02, waveDensity: 10, waveSpeed: 1.0,
    vignetteStrength: 0.3, vignetteSoftness: 0.5, displacementStrength: 0.01,
  };

  class TripEngine {
    constructor(canvas) {
      this.canvas = canvas;
      // powerPreference: on dual-GPU machines the browser defaults to the
      // integrated chip. Ask for the discrete one.
      const o = { powerPreference: 'high-performance', preserveDrawingBuffer: true, alpha: false };
      this.gl = canvas.getContext('webgl2', o) || canvas.getContext('webgl', o);
      if (!this.gl) throw new Error('WebGL unavailable.');

      this.effect = 'datamosh';
      this.params = { ...DEFAULTS };
      this.frozen = false;
      this.audio = null;
      this.audioLevel = 0;
      this.t0 = performance.now();
      this.raf = 0;
      this.programs = {};
      this.source = null;          // <video> | <canvas> | <img>

      this._contextLost = false;
      this._initGeom();
      this._initTextures();
      this._compileAll();
      this._wireContextLoss();
    }

    // F3 — WebGL context loss (OS sleep, GPU reset, driver eviction, or too many
    // live contexts) invalidates every texture/program/buffer. Without this the
    // draw loop keeps issuing dead GL calls forever and the canvas is bricked
    // until a full reload. We halt on loss and fully rebuild on restore.
    _wireContextLoss() {
      const cv = this.canvas;
      if (!cv || !cv.addEventListener || cv._tripCtxWired) return;
      cv._tripCtxWired = true;
      cv.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();                       // REQUIRED, or the context won't be restored
        this._contextLost = true;
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        // Every GL object tied to this context is now dead. Drop the texture
        // refs (#20 pooling) so the restore path rebuilds fresh textures rather
        // than reusing invalidated handles.
        this.srcTex = this.ping = this.pong = null;
        try { console.warn('[trip] WebGL context lost — halting until restored'); } catch (_) {}
      }, false);
      cv.addEventListener('webglcontextrestored', () => {
        try { console.warn('[trip] WebGL context restored — rebuilding'); } catch (_) {}
        // every GL object is gone; rebuild geometry, textures and programs.
        this.programs = {};
        this._initGeom();
        this._initTextures();
        this._compileAll();
        this._contextLost = false;
        this.start();                             // resume the render loop
      }, false);
    }

    _initGeom() {
      const gl = this.gl;
      const quad = new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]);
      const uv   = new Float32Array([ 0, 0, 1, 0,  0,1,  0,1, 1, 0, 1,1]);
      this.posBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
      this.uvBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
      gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    }

    _mkTex(w, h) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return t;
    }

    /** Free the ping-pong textures/framebuffers. Called before re-allocating
     *  (every adaptive-quality resize) and on teardown — without this the GPU
     *  leaks 3 textures + 2 framebuffers on EVERY qScale tier change, which
     *  during a live set accumulates until the context is lost. */
    _freeTextures() {
      const gl = this.gl;
      if (!gl) return;
      if (this.srcTex) { gl.deleteTexture(this.srcTex); this.srcTex = null; }
      for (const p of [this.ping, this.pong]) {
        if (p) { if (p.tex) gl.deleteTexture(p.tex); if (p.fb) gl.deleteFramebuffer(p.fb); }
      }
      this.ping = this.pong = null;
    }

    /** Re-specify an existing texture's storage at a new size (no new object). */
    _sizeTex(t, w, h) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    /** Ping-pong buffers — this is what makes the temporal feedback real.
     *  #20 texture pooling — reuse the texture + FBO objects across adaptive-
     *  quality resizes instead of delete+recreate. The old path freed and
     *  reallocated 3 textures + 2 framebuffers on EVERY qScale tier change,
     *  churning GPU objects and leaning on the GC for the whole of a live set.
     *  Now they're created once and only their storage is re-specified on a
     *  resize; the framebuffer objects (and their attachments) are reused. */
    _initTextures() {
      const gl = this.gl;
      const w = this.canvas.width || 1280, h = this.canvas.height || 720;

      if (!this.srcTex) {
        this.srcTex = gl.createTexture();     // uploaded from the video each frame — no fixed storage here
        gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      }

      if (!this.ping) this.ping = { tex: this._mkTex(w, h), fb: gl.createFramebuffer() };
      else this._sizeTex(this.ping.tex, w, h);
      if (!this.pong) this.pong = { tex: this._mkTex(w, h), fb: gl.createFramebuffer() };
      else this._sizeTex(this.pong.tex, w, h);

      for (const p of [this.ping, this.pong]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, p.fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, p.tex, 0);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    _compile(type, src) {
      const gl = this.gl;
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const e = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error('Shader compile failed: ' + e);
      }
      return s;
    }

    _compileAll() {
      const gl = this.gl;
      // The fragments are injectRotation-patched to read `v_texCoord_in`, so the
      // shared vertex shader must OUTPUT that varying name or strict GL drivers
      // refuse to link (see FFShaderPlus.patchVertex). Patch both, or neither.
      const vsrc = window.FFShaderPlus && window.FFShaderPlus.patchVertex
        ? window.FFShaderPlus.patchVertex(VERT) : VERT;
      const vs = this._compile(gl.VERTEX_SHADER, vsrc);
      for (const [name, fsrc] of Object.entries(SHADERS)) {
        try {
          // Retrofit u_cameraRotation onto the shaders I ported without it.
          const patched = window.FFShaderPlus
            ? window.FFShaderPlus.injectRotation(fsrc) : fsrc;
          const fs = this._compile(gl.FRAGMENT_SHADER, patched);
          const p = gl.createProgram();
          gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
          if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            console.warn(`[trip] link failed for ${name}:`, gl.getProgramInfoLog(p));
            continue;
          }
          const loc = {};
          for (const u of U) loc[u] = gl.getUniformLocation(p, u);
          loc.u_webcamTexture        = gl.getUniformLocation(p, 'u_webcamTexture');
          loc.u_previousFrameTexture = gl.getUniformLocation(p, 'u_previousFrameTexture');
          loc.a_position = gl.getAttribLocation(p, 'a_position');
          loc.a_texCoord = gl.getAttribLocation(p, 'a_texCoord');
          this.programs[name] = { p, loc };
        } catch (e) {
          console.warn(`[trip] ${name}:`, e.message);
        }
      }
      const ok = Object.keys(this.programs);
      console.log(`[trip] ${ok.length}/${Object.keys(SHADERS).length} shaders compiled:`, ok.join(', '));
    }

    setSource(el) { this.source = el; }
    setEffect(id, keepParams) {
      if (!this.programs[id]) return;
      this.effect = id;
      // One global default patch is wrong: Feedback wants a very different
      // starting point from Kaleidoscope. Land somewhere that already looks good.
      if (!keepParams && window.FFShaderPlus) {
        window.FFShaderPlus.applyEffectDefaults(this, id);
      }
    }
    setParam(k, v) { this.params[k] = v; }
    setParams(o) { Object.assign(this.params, o); }
    applyPreset(name) {
      const p = PRESETS[name];
      if (!p) return;
      // TRIP's preset keys are short — map them onto the uniform names.
      const M = {
        trail: 'trailPersistence', motion: 'motionThreshold', hue: 'hueShiftSpeed',
        extrap: 'motionExtrapolation', intensity: 'intensity', displacement: 'displacement',
        feedback: 'feedback', threshold: 'threshold', brightness: 'brightness',
        contrast: 'contrast', saturation: 'saturation',
      };
      for (const [k, v] of Object.entries(p)) if (M[k]) this.params[M[k]] = v;
    }
    freeze(on) { this.frozen = !!on; }

    /**
     * THREE-BAND audio reactivity.
     *
     * The old version averaged the ENTIRE spectrum into one number and pushed it
     * at u_intensity. That is musically useless: a kick drum and a hi-hat move
     * the same slider by the same amount.
     *
     * Now: BASS / MID / TREBLE, each gated by its own threshold, each routable to
     * different uniforms. The kick punches the zoom while the hats shimmer the
     * chroma. That is the difference between "reacts to audio" and "reacts to
     * the MUSIC".
     */
    attachAudio(mediaEl) {
      try {
        this.band = new window.FFShaderPlus.BandAnalyser();
        if (mediaEl instanceof MediaStream) {
          const AC = window.AudioContext || window.webkitAudioContext;
          const ac = new AC();
          const src = ac.createMediaStreamSource(mediaEl);
          this.band.ctx = ac;
          this.band.an = ac.createAnalyser();
          this.band.an.fftSize = 256;
          this.band.an.smoothingTimeConstant = 0.8;
          src.connect(this.band.an);
          this.band.data = new Uint8Array(this.band.an.frequencyBinCount);
          this.band.enabled = true;
        } else {
          this.band.fromElement(mediaEl);
        }
        this.audio = true;
      } catch (e) {
        console.warn('[trip] audio attach failed:', e.message);
      }
    }
    detachAudio() { this.band && this.band.close(); this.band = null; this.audio = null; }

    /** Which band drives what. See FFShaderPlus.ROUTES. */
    setAudioRoute(name) { this.audioRoute = name; }

    _sampleAudio() {
      if (!this.band || !this.band.enabled) {
        this.audioLevel = 0;
        this.bands = { bass: 0, mid: 0, treble: 0, level: 0 };
        return;
      }
      this.bands = this.band.read();
      this.audioLevel = this.bands.level;
      if (this.audioRoute && this.audioRoute !== 'off') {
        window.FFShaderPlus.routeAudio(this, this.bands, this.audioRoute, this.audioAmount || 1);
      }
    }

    _uploadSource() {
      const gl = this.gl, s = this.source;
      if (!s || this.frozen) return;
      const w = s.videoWidth || s.width, h = s.videoHeight || s.height;
      if (!w || !h) return;
      if (s.readyState !== undefined && s.readyState < 2) return;

      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s);
    }

    render() {
      const gl = this.gl;
      // F3 — never touch GL while the context is lost/restoring.
      if (this._contextLost || (gl.isContextLost && gl.isContextLost())) return;
      const prog = this.programs[this.effect] || this.programs.datamosh;
      if (!prog) return;

      // Adaptive quality (performance.js): render at a lower INTERNAL
      // resolution when the frame rate drops and let CSS scale the canvas back
      // up to its layout size. clientWidth/clientHeight are the CSS size and are
      // unaffected by the backing-store size, so there's no feedback loop. This
      // is the "shed resolution first" lever — the single biggest GPU saving.
      const qScale = (window.FFPerf && +window.FFPerf.scale) || 1;
      const w = Math.max(2, Math.round((this.canvas.clientWidth  || 1280) * qScale));
      const h = Math.max(2, Math.round((this.canvas.clientHeight || 720) * qScale));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w; this.canvas.height = h;
        this._initTextures();
      }

      this._sampleAudio();
      this._uploadSource();

      const { p, loc } = prog;
      gl.useProgram(p);
      gl.viewport(0, 0, w, h);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.enableVertexAttribArray(loc.a_position);
      gl.vertexAttribPointer(loc.a_position, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
      gl.enableVertexAttribArray(loc.a_texCoord);
      gl.vertexAttribPointer(loc.a_texCoord, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      if (loc.u_webcamTexture) gl.uniform1i(loc.u_webcamTexture, 0);

      // Previous frame — the ping-pong feedback that makes the trails real.
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.pong.tex);
      if (loc.u_previousFrameTexture) gl.uniform1i(loc.u_previousFrameTexture, 1);

      const t = (performance.now() - this.t0) / 1000;
      const a = this.audioLevel;
      const P = this.params;
      const B = this.bands || { bass: 0, mid: 0, treble: 0 };

      const set = (u, v) => { if (loc[u]) gl.uniform1f(loc[u], v); };
      if (loc.u_time)       gl.uniform1f(loc.u_time, t);
      if (loc.u_resolution) gl.uniform2f(loc.u_resolution, w, h);

      // Camera rotation — device tilt on mobile, a fix for upside-down feeds,
      // and a performable parameter in its own right. Every Trippy Cam 2.0
      // shader rotates its texture coords by this before doing anything else.
      if (loc.u_cameraRotation) {
        const R = window.FFShaderPlus && window.FFShaderPlus.Rotation;
        gl.uniform1f(loc.u_cameraRotation, R ? R.angle : Math.PI);
      }
      // The three bands, exposed directly to any shader that wants them.
      if (loc.u_audioBass)   gl.uniform1f(loc.u_audioBass,   B.bass);
      if (loc.u_audioMid)    gl.uniform1f(loc.u_audioMid,    B.mid);
      if (loc.u_audioTreble) gl.uniform1f(loc.u_audioTreble, B.treble);
      if (loc.u_displacementMapStrength) {
        gl.uniform1f(loc.u_displacementMapStrength, P.displacementMapStrength || 0.03);
      }

      // Audio-reactive lift on the two params that read best musically.
      set('u_intensity',           P.intensity + a * 0.6);
      set('u_glitchStrength',      P.glitchStrength + a * 0.5);
      set('u_threshold',           P.threshold);
      set('u_displacement',        P.displacement);
      set('u_displacementStrength',P.displacementStrength);
      set('u_feedback',            P.feedback);
      set('u_trailPersistence',    P.trailPersistence);
      set('u_motionThreshold',     P.motionThreshold);
      set('u_motionExtrapolation', P.motionExtrapolation);
      set('u_hueShiftSpeed',       P.hueShiftSpeed);
      set('u_saturation',          P.saturation);
      set('u_brightness',          P.brightness);
      set('u_contrast',            P.contrast);
      set('u_scanlineDensity',     P.scanlineDensity);
      set('u_scanlineIntensity',   P.scanlineIntensity);
      set('u_phosphorOffset',      P.phosphorOffset);
      set('u_curvatureAmount',     P.curvatureAmount);
      set('u_kaleidoSegments',     P.kaleidoSegments);
      set('u_fisheyeStrength',     P.fisheyeStrength);
      set('u_waveAmplitude',       P.waveAmplitude);
      set('u_waveDensity',         P.waveDensity);
      set('u_waveSpeed',           P.waveSpeed);
      set('u_vignetteStrength',    P.vignetteStrength);
      set('u_vignetteSoftness',    P.vignetteSoftness);

      // Draw into ping (so the result is available as "previous frame" next tick)…
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.ping.fb);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      // …and to the screen.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      const t2 = this.ping; this.ping = this.pong; this.pong = t2;   // swap
    }

    start() {
      // #17: if the source is an HTMLVideoElement, use requestVideoFrameCallback
      // for frame-accurate updates (one callback per actual video frame, not
      // per rAF tick). Fall back to rAF for canvas/image sources.
      if (this.source && typeof this.source.requestVideoFrameCallback === 'function') {
        const loop = (now, meta) => {
          this.render();
          try { this.source.requestVideoFrameCallback(loop); } catch (_) { this.raf = requestAnimationFrame(loop); }
        };
        try { this.source.requestVideoFrameCallback(loop); }
        catch (_) { this.raf = requestAnimationFrame(() => { this.render(); this.raf = requestAnimationFrame(arguments.callee); }); }
      } else {
        const loop = () => { this.render(); this.raf = requestAnimationFrame(loop); };
        if (!this.raf) loop();
      }
    }
    stop()  {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      // rVFC can't be "cancelled" the same way; the next source frame will
      // simply not request another callback if the engine has been stopped.
    }
    randomize() {
      for (const k of ['intensity','threshold','displacement','feedback','trailPersistence',
                       'glitchStrength','hueShiftSpeed','waveAmplitude','fisheyeStrength']) {
        const d = DEFAULTS[k];
        this.params[k] = +(d * (0.2 + Math.random() * 1.8)).toFixed(4);
      }
      this.effect = EFFECTS[Math.floor(Math.random() * EFFECTS.length)].id;
    }
    snapshot() { return new Promise((r) => this.canvas.toBlob(r, 'image/png')); }
  }

  // ===========================================================================
  // RECORDING → straight into the Media Bin. This is what closes the loop.
  // ===========================================================================

  const REC = { rec: null, chunks: [], t0: 0, raf: 0 };

  function startRec(canvas, fps = 30) {
    if (REC.rec) return stopRec();
    const stream = canvas.captureStream(fps);
    // iOS/Safari has no webm encoder — fall through to mp4 (see pickRecorderMime).
    const mime = (window.pickRecorderMime || (() => 'video/webm'))(
      'video/webm;codecs=vp9', 'video/webm', 'video/mp4;codecs=h264', 'video/mp4');
    REC.chunks = [];
    REC.rec = new MediaRecorder(stream, mime
      ? { mimeType: mime, videoBitsPerSecond: 8_000_000 }
      : { videoBitsPerSecond: 8_000_000 });
    REC.t0 = Date.now();
    REC.rec.ondataavailable = (e) => { if (e.data.size) REC.chunks.push(e.data); };
    REC.rec.onstop = async () => {
      const type = (REC.rec.mimeType || 'video/webm').split(';')[0];
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(REC.chunks, { type });
      const name = `tripcam-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${ext}`;
      // Recordings are TAKES. They belong in the Clip Library, where you can
      // review them, reorder them, and sequence them — not lost in the media bin
      // next to your source footage.
      window.FFClips?.add(blob, name, { source: 'tripcam' });
      await window.addBlobToBin?.(blob, name, type);
      window.logToConsole?.('ok',
        `${name} → Media Bin. Run any of the 180 workflows on it, or hit "Send to Editor".`);
      REC.rec = null; REC.chunks = [];
      document.getElementById('trip-rec-btn')?.classList.remove('recording');
    };
    REC.rec.start(200);
    document.getElementById('trip-rec-btn')?.classList.add('recording');
    window.logToConsole?.('', 'Trip Cam recording…');
  }
  function stopRec() { try { REC.rec?.stop(); } catch (_) {} }

  // ===========================================================================
  // BAKE TO FFMPEG — reverse-map the live shader config to a workflow.
  // ===========================================================================

  function bakeToFFmpeg(engine) {
    const P = engine.params;
    const vf = [];
    if (P.brightness !== 0 || P.contrast !== 1 || P.saturation !== 1) {
      vf.push(`eq=brightness=${P.brightness.toFixed(3)}:contrast=${P.contrast.toFixed(3)}:saturation=${P.saturation.toFixed(3)}`);
    }
    if (P.hueShiftSpeed) vf.push(`hue=h=${(P.hueShiftSpeed * 360).toFixed(0)}`);
    if (P.trailPersistence > 0.5) vf.push(`lagfun=decay=${Math.min(0.99, P.trailPersistence).toFixed(3)}`);
    if (P.phosphorOffset > 0.001) {
      const px = Math.round(P.phosphorOffset * 1000);
      vf.push(`rgbashift=rh=${px}:bh=-${px}`);
    }
    if (P.scanlineIntensity > 0.05) {
      const sp = Math.max(2, Math.round(720 / (P.scanlineDensity || 400) * 4));
      vf.push(`geq=lum='lum(X,Y)*(1-${P.scanlineIntensity.toFixed(2)}*mod(Y,${sp})/${sp})':cb='cb(X,Y)':cr='cr(X,Y)'`);
    }
    if (P.curvatureAmount > 0.02) vf.push(`lenscorrection=k1=${P.curvatureAmount.toFixed(3)}:k2=${P.curvatureAmount.toFixed(3)}`);
    if (P.glitchStrength > 0.2) vf.push(`noise=alls=${Math.round(P.glitchStrength * 40)}:allf=t+u`);
    if (P.vignetteStrength > 0.05) vf.push(`vignette=angle=${(P.vignetteStrength * 1.2).toFixed(2)}`);

    const chain = vf.join(',') || 'null';
    const wf = {
      id: `tripcam-${Date.now()}`,
      name: `Trip Cam — ${EFFECTS.find(e => e.id === engine.effect)?.label || engine.effect}`,
      category: 'my-custom',
      description: 'Baked from a live Trip Cam shader configuration.',
      tags: ['tripcam', 'glitch', 'custom', engine.effect],
      icon: '🌀',
      rawVf: chain,
      settings: {},
    };

    try {
      const key = window.FFStorage?.KEY_CUSTOM || 'ffs.customWorkflows.v1';
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      list.push(wf);
      localStorage.setItem(key, JSON.stringify(list));
      window.logToConsole?.('ok', `Baked → "${wf.name}" saved to My Custom.`);
      window.logToConsole?.('', `-vf "${chain}"`);
      window.renderWorkflows?.();
    } catch (e) {
      window.logToConsole?.('error', `Bake failed: ${e.message}`);
    }
    return wf;
  }

  window.TripCam = { TripEngine, EFFECTS, PRESETS, DEFAULTS, SHADERS, startRec, stopRec, bakeToFFmpeg };
})();
