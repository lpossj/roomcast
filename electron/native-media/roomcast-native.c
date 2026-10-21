/* SPDX-License-Identifier: GPL-2.0-or-later
 * Encoded-only bridge for the bundled OBS 32.1.2. No capture/codec runtime.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <obs-module.h>
#include <util/platform.h>
#include "obs-studio-32.1.2-sources/plugins/obs-websocket/lib/obs-websocket-api.h"

OBS_DECLARE_MODULE()

struct bridge_output {
    obs_output_t *output;
    volatile LONG running;
    char session[129];
    uint64_t bytes;
};

static obs_websocket_vendor vendor;
static CRITICAL_SECTION control;
static obs_output_t *active_output;
static obs_encoder_t *active_encoder;
static char active_session[129];
static char active_encoder_id[64];
static int bitrate_kbps, vbv_bits;
static ULONGLONG last_idr_ms;
static bool unloading;
static char retired_sessions[64][129];
static unsigned retired_cursor;

static bool retired(const char *session)
{
    for (unsigned i = 0; i < 64; i++)
        if (strcmp(session, retired_sessions[i]) == 0) return true;
    return false;
}
static void retire(const char *session)
{
    if (session[0] && strlen(session) <= 128 && !retired(session))
        snprintf(retired_sessions[retired_cursor++ % 64], 129, "%s", session);
}

static char *base64(const uint8_t *first, size_t first_size, const uint8_t *data, size_t size)
{
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t total = first_size + size;
    if (total > 4 * 1024 * 1024) return NULL;
    char *out = malloc(4 * ((total + 2) / 3) + 1);
    if (!out) return NULL;
    size_t i = 0, j = 0;
    while (i < total) {
        size_t remain = total - i;
        uint32_t word = 0;
        for (unsigned n = 0; n < 3; n++) {
            word <<= 8;
            if (i < total) { word |= i < first_size ? first[i] : data[i - first_size]; i++; }
        }
        out[j++] = alphabet[(word >> 18) & 63];
        out[j++] = alphabet[(word >> 12) & 63];
        out[j++] = remain > 1 ? alphabet[(word >> 6) & 63] : '=';
        out[j++] = remain > 2 ? alphabet[word & 63] : '=';
    }
    out[j] = 0;
    return out;
}

static const char *output_name(void *unused) { (void)unused; return "Roomcast encoded video bridge"; }
static void *output_create(obs_data_t *settings, obs_output_t *output)
{
    struct bridge_output *ctx = calloc(1, sizeof(*ctx));
    if (!ctx) return NULL;
    ctx->output = output;
    snprintf(ctx->session, sizeof(ctx->session), "%s", obs_data_get_string(settings, "session"));
    return ctx;
}
static void output_destroy(void *data) { free(data); }
static bool output_start(void *data)
{
    struct bridge_output *ctx = data;
    if (!obs_output_can_begin_data_capture(ctx->output, 0) ||
        !obs_output_initialize_encoders(ctx->output, 0)) return false;
    InterlockedExchange(&ctx->running, 1);
    if (!obs_output_begin_data_capture(ctx->output, 0)) {
        InterlockedExchange(&ctx->running, 0);
        return false;
    }
    return true;
}
static void output_stop(void *data, uint64_t timestamp)
{
    (void)timestamp;
    struct bridge_output *ctx = data;
    InterlockedExchange(&ctx->running, 0);
    obs_output_end_data_capture(ctx->output);
}
static void output_packet(void *data, struct encoder_packet *packet)
{
    struct bridge_output *ctx = data;
    if (!InterlockedCompareExchange(&ctx->running, 0, 0) || !packet || !packet->data ||
        packet->type != OBS_ENCODER_VIDEO || packet->timebase_den <= 0) return;
    uint8_t *headers = NULL;
    size_t header_size = 0;
    if (packet->keyframe)
        obs_encoder_get_extra_data(packet->encoder, &headers, &header_size);
    char *encoded = base64(headers, header_size, packet->data, packet->size);
    if (!encoded) return;
    obs_data_t *event = obs_data_create();
    obs_data_set_string(event, "session", ctx->session);
    obs_data_set_string(event, "data", encoded);
    obs_data_set_int(event, "ptsUs", packet->pts * 1000000LL * packet->timebase_num / packet->timebase_den);
    obs_data_set_int(event, "dtsUs", packet->dts * 1000000LL * packet->timebase_num / packet->timebase_den);
    FILETIME ft;
    ULARGE_INTEGER ticks;
    GetSystemTimePreciseAsFileTime(&ft);
    ticks.LowPart = ft.dwLowDateTime;
    ticks.HighPart = ft.dwHighDateTime;
    int64_t now_us = (int64_t)(ticks.QuadPart / 10 - 11644473600000000ULL);
    int64_t epoch_us = now_us - ((int64_t)(os_gettime_ns() / 1000) - packet->sys_dts_usec);
    epoch_us += (packet->pts - packet->dts) * 1000000LL * packet->timebase_num / packet->timebase_den;
    obs_data_set_int(event, "epochUs", epoch_us);
    obs_data_set_bool(event, "keyframe", packet->keyframe);
    obs_data_set_int(event, "bytes", packet->size + header_size);
    if (InterlockedCompareExchange(&ctx->running, 0, 0))
        obs_websocket_vendor_emit_event(vendor, "Frame", event);
    ctx->bytes += packet->size + header_size;
    obs_data_release(event);
    free(encoded);
}
static uint64_t output_bytes(void *data) { return ((struct bridge_output *)data)->bytes; }

static struct obs_output_info output_info = {
    .id = "roomcast_native_output", .flags = OBS_OUTPUT_VIDEO | OBS_OUTPUT_ENCODED,
    .get_name = output_name, .create = output_create, .destroy = output_destroy,
    .start = output_start, .stop = output_stop, .encoded_packet = output_packet,
    .get_total_bytes = output_bytes, .encoded_video_codecs = "h264"
};

static void stop_active(void)
{
    if (active_output) {
        obs_output_force_stop(active_output);
        obs_output_release(active_output);
        active_output = NULL;
    }
    if (active_encoder) { obs_encoder_release(active_encoder); active_encoder = NULL; }
    active_session[0] = 0;
    active_encoder_id[0] = 0;
}
static void result(obs_data_t *response, bool ok, const char *message)
{
    obs_data_set_bool(response, "ok", ok);
    obs_data_set_string(response, "message", message);
}
static bool matches(obs_data_t *request)
{
    const char *session = obs_data_get_string(request, "session");
    return active_output && session[0] && strcmp(session, active_session) == 0;
}
static void describe(obs_data_t *response)
{
    struct obs_video_info info = {0};
    obs_get_video_info(&info);
    obs_data_set_string(response, "session", active_session);
    obs_data_set_string(response, "encoderId", active_encoder_id);
    obs_data_set_string(response, "rateControl", "CBR");
    obs_data_set_int(response, "bitrateKbps", bitrate_kbps);
    obs_data_set_int(response, "vbvBits", vbv_bits);
    obs_data_set_int(response, "width", info.output_width);
    obs_data_set_int(response, "height", info.output_height);
    obs_data_set_int(response, "fpsNum", info.fps_num);
    obs_data_set_int(response, "fpsDen", info.fps_den);
    obs_data_set_bool(response, "bFrames", false);
    obs_data_set_bool(response, "lookahead", false);
    obs_data_set_string(response, "tune", strcmp(active_encoder_id, "obs_x264") == 0 ? "zerolatency" : "ull");
}
static bool try_encoder(const char *id, const char *session, int bitrate, const struct obs_video_info *info)
{
    obs_data_t *settings = obs_data_create();
    const bool hardware = strcmp(id, "obs_x264") != 0;
    obs_data_set_string(settings, "rate_control", "CBR");
    obs_data_set_int(settings, "bitrate", bitrate);
    obs_data_set_int(settings, "max_bitrate", bitrate);
    obs_data_set_int(settings, "keyint_sec", 1);
    obs_data_set_int(settings, "bf", 0);
    obs_data_set_bool(settings, "lookahead", false);
    obs_data_set_bool(settings, "adaptive_quantization", false);
    obs_data_set_bool(settings, "repeat_headers", false);
    obs_data_set_string(settings, "profile", "high");
    obs_data_set_string(settings, "preset", hardware ? "p3" : "veryfast");
    obs_data_set_string(settings, "tune", hardware ? "ull" : "zerolatency");
    obs_data_set_string(settings, "multipass", "disabled");
    vbv_bits = (int)((int64_t)bitrate * 1000 * info->fps_den / info->fps_num);
    if (!hardware) vbv_bits = ((vbv_bits + 999) / 1000) * 1000;
    obs_data_set_bool(settings, "use_bufsize", true);
    obs_data_set_int(settings, "buffer_size", (vbv_bits + 999) / 1000);
    char opts[256];
    snprintf(opts, sizeof(opts), "vbvBufferSize=%d vbvInitialDelay=%d", vbv_bits, vbv_bits);
    obs_data_set_string(settings, "opts", opts);
    snprintf(opts, sizeof(opts), "bframes=0 rc-lookahead=0 sync-lookahead=0 vbv-bufsize=%d nal-hrd=cbr force-cfr=1", (vbv_bits + 999) / 1000);
    obs_data_set_string(settings, "x264opts", opts);
    active_encoder = obs_video_encoder_create(id, "Roomcast Native H264", settings, NULL);
    obs_data_release(settings);
    if (!active_encoder) return false;
    obs_encoder_set_video(active_encoder, obs_get_video());
    settings = obs_data_create();
    obs_data_set_string(settings, "session", session);
    active_output = obs_output_create("roomcast_native_output", "Roomcast Native", settings, NULL);
    obs_data_release(settings);
    if (!active_output) { stop_active(); return false; }
    obs_output_set_video_encoder(active_output, active_encoder);
    if (!obs_output_start(active_output)) {
        blog(LOG_WARNING, "[roomcast-native] Encoder %s failed: %s", id, obs_encoder_get_last_error(active_encoder));
        stop_active();
        return false;
    }
    snprintf(active_encoder_id, sizeof(active_encoder_id), "%s", id);
    snprintf(active_session, sizeof(active_session), "%s", session);
    bitrate_kbps = bitrate;
    last_idr_ms = 0;
    blog(LOG_INFO, "[roomcast-native] active encoder=%s CBR=%d vbvBits=%d fps=%u/%u", id, bitrate, vbv_bits, info->fps_num, info->fps_den);
    return true;
}
static void request_start(obs_data_t *request, obs_data_t *response, void *unused)
{
    (void)unused;
    const char *session = obs_data_get_string(request, "session");
    int bitrate = (int)obs_data_get_int(request, "bitrateKbps");
    EnterCriticalSection(&control);
    if (unloading || !session[0] || strlen(session) > 128 || retired(session) || bitrate < 300 || bitrate > 6500) {
        result(response, false, "Invalid session or bitrate (300..6500 Kbps).");
    } else if (active_output) {
        result(response, matches(request), matches(request) ? "Already active." : "Another session is active.");
        if (matches(request)) describe(response);
    } else {
        struct obs_video_info info = {0};
        if (!obs_get_video_info(&info) || !info.fps_num || !info.fps_den) {
            result(response, false, "OBS video is not ready.");
        } else {
            bool ok = try_encoder("obs_nvenc_h264_tex", session, bitrate, &info);
            if (!ok) ok = try_encoder("obs_x264", session, bitrate, &info);
            result(response, ok, ok ? "Started." : "No encoder could initialize.");
            if (ok) describe(response);
        }
    }
    LeaveCriticalSection(&control);
}
static void request_stop(obs_data_t *request, obs_data_t *response, void *unused)
{
    (void)unused;
    EnterCriticalSection(&control);
    bool ok = matches(request);
    retire(obs_data_get_string(request, "session"));
    if (ok) stop_active();
    result(response, ok, ok ? "Stopped." : "Session is not active.");
    LeaveCriticalSection(&control);
}
static void request_bitrate(obs_data_t *request, obs_data_t *response, void *unused)
{
    (void)unused;
    EnterCriticalSection(&control);
    int bitrate = (int)obs_data_get_int(request, "bitrateKbps");
    if (!matches(request) || bitrate < 300 || bitrate > 6500) {
        result(response, false, "Invalid active session or bitrate.");
    } else {
        obs_data_t *settings = obs_encoder_get_settings(active_encoder);
        obs_data_set_int(settings, "bitrate", bitrate);
        obs_data_set_int(settings, "max_bitrate", bitrate);
        obs_encoder_update(active_encoder, settings);
        obs_data_release(settings);
        bitrate_kbps = bitrate;
        result(response, true, "Bitrate update requested; initial VBV size is retained.");
        describe(response);
    }
    LeaveCriticalSection(&control);
}
static void request_keyframe(obs_data_t *request, obs_data_t *response, void *unused)
{
    (void)unused;
    EnterCriticalSection(&control);
    if (!matches(request)) result(response, false, "Session is not active.");
    else if (strcmp(active_encoder_id, "obs_x264") == 0) {
        result(response, true, "Next periodic IDR is due within one second.");
        obs_data_set_bool(response, "immediate", false);
    } else {
        ULONGLONG now = GetTickCount64();
        bool refresh = !last_idr_ms || now - last_idr_ms >= 300;
        if (refresh) {
            obs_data_t *settings = obs_encoder_get_settings(active_encoder);
            obs_encoder_update(active_encoder, settings);
            obs_data_release(settings);
            last_idr_ms = now;
        }
        result(response, true, refresh ? "NVENC IDR requested." : "IDR request coalesced.");
        obs_data_set_bool(response, "immediate", refresh);
    }
    LeaveCriticalSection(&control);
}
static void request_status(obs_data_t *request, obs_data_t *response, void *unused)
{
    (void)unused;
    EnterCriticalSection(&control);
    bool ok = matches(request);
    result(response, ok, ok ? "Active." : "Session is not active.");
    if (ok) describe(response);
    LeaveCriticalSection(&control);
}
MODULE_EXPORT bool obs_module_load(void)
{
    InitializeCriticalSection(&control);
    obs_register_output(&output_info);
    return true;
}
MODULE_EXPORT void obs_module_post_load(void)
{
    vendor = obs_websocket_register_vendor("roomcast-native");
    if (!vendor) { blog(LOG_ERROR, "[roomcast-native] obs-websocket vendor registration failed"); return; }
    obs_websocket_vendor_register_request(vendor, "start", request_start, NULL);
    obs_websocket_vendor_register_request(vendor, "stop", request_stop, NULL);
    obs_websocket_vendor_register_request(vendor, "bitrate", request_bitrate, NULL);
    obs_websocket_vendor_register_request(vendor, "keyframe", request_keyframe, NULL);
    obs_websocket_vendor_register_request(vendor, "status", request_status, NULL);
    blog(LOG_INFO, "[roomcast-native] encoded bridge ready");
}
MODULE_EXPORT void obs_module_unload(void)
{
    EnterCriticalSection(&control);
    unloading = true;
    stop_active();
    LeaveCriticalSection(&control);
    if (vendor) {
        obs_websocket_vendor_unregister_request(vendor, "start");
        obs_websocket_vendor_unregister_request(vendor, "stop");
        obs_websocket_vendor_unregister_request(vendor, "bitrate");
        obs_websocket_vendor_unregister_request(vendor, "keyframe");
        obs_websocket_vendor_unregister_request(vendor, "status");
    }
    DeleteCriticalSection(&control);
}
