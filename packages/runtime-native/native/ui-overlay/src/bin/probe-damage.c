/* PRD-611 probe: does the page's compositor frame carry the whole HUD?
 * A transparent WebKitGTK view commits only the damaged region unless the whole surface is damaged, so a
 * full-viewport near-invisible layer (alpha 1/255) whose transform is nudged by 0.01 px is added: every pixel it
 * covers is non-zero, so a zero word marks a partial buffer. Each damage-event the view is drawn into a cairo
 * surface; complete buffers (coverage pixels stripped) are compared against webkit_web_view_get_snapshot.
 * Expect "badSteps 0" and maxDelta 1. Same layer and nudge as COMPOSITOR_STYLE/COMPOSITOR_NUDGE in offscreen.rs.
 *   gcc -O2 -o probe-damage probe-damage.c $(pkg-config --cflags --libs webkit2gtk-4.1 gtk+-3.0)
 *   sh scripts/xvfb.sh env SW=1920 SH=1080 SENT=1 STEPS=40 ./probe-damage */
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static GtkWidget *g_window; static WebKitWebView *g_view;
static int W = 1920, H = 1080;
static cairo_surface_t *g_b, *g_snap; static uint32_t *g_acc;
static int g_complete = 0, g_partial = 0; static int g_sent = 1, g_steps = 60, g_step = 0, g_frames = 0, g_bad_total = 0;
static double g_draw_ms = 0, g_merge_ms = 0; static long g_merged_words = 0;
static double now_ms(void) { return g_get_monotonic_time() / 1000.0; }

static gboolean on_damage(GtkWidget *w, GdkEvent *e, gpointer d) {
    (void)w; (void)e; (void)d;
    double t0 = now_ms();
    cairo_t *cr = cairo_create(g_b);
    cairo_set_operator(cr, CAIRO_OPERATOR_CLEAR); cairo_paint(cr); cairo_set_operator(cr, CAIRO_OPERATOR_OVER);
    gtk_widget_draw(GTK_WIDGET(g_view), cr); cairo_destroy(cr); cairo_surface_flush(g_b);
    double t1 = now_ms();
    const uint32_t *b = (const uint32_t *)cairo_image_surface_get_data(g_b);
    const int stride = cairo_image_surface_get_stride(g_b) / 4;
    long n = 0; int complete = 1;
    for (int y = 0; y < H && complete; y++) { const uint32_t *row = b + (long)y * stride; for (int x = 0; x < W; x++) if (!row[x]) { complete = 0; break; } }
    if (complete) { for (int y = 0; y < H; y++) { const uint32_t *row = b + (long)y * stride; uint32_t *dst = g_acc + (long)y * W; for (int x = 0; x < W; x++) { uint32_t v = row[x]; dst[x] = (v == 0x01000000u) ? 0 : v; } } n = (long)W * H; g_complete++; } else g_partial++;
    g_merge_ms += now_ms() - t1; g_draw_ms += t1 - t0; g_merged_words += n; g_frames++;
    return FALSE;
}

static void compare(void) {
    cairo_surface_flush(g_snap);
    const uint8_t *s = cairo_image_surface_get_data(g_snap); const int ss = cairo_image_surface_get_stride(g_snap);
    long bad2 = 0, bad8 = 0; int maxd = 0;
    for (int y = 0; y < H; y++) { const uint8_t *sr = s + (long)y * ss; const uint8_t *ar = (const uint8_t *)(g_acc + (long)y * W);
        for (int x = 0; x < W * 4; x++) { int d = abs(sr[x] - ar[x]); if (d > maxd) maxd = d; if (d > 2) bad2++; if (d > 8) bad8++; } }
    printf("complete %d partial %d ", g_complete, g_partial); g_complete = g_partial = 0; printf("step %d frames %d maxDelta %d bytes>2 %ld bytes>8 %ld drawMs %.2f mergeMs %.2f mergedPx/frame %.0f\n", g_step, g_frames, maxd, bad2, bad8,
           g_frames ? g_draw_ms / g_frames : 0, g_frames ? g_merge_ms / g_frames : 0, g_frames ? (double)g_merged_words / g_frames : 0);
    if (bad8) g_bad_total++;
    if (getenv("PNG") && bad8) { cairo_surface_t *im = cairo_image_surface_create_for_data((unsigned char *)g_acc, CAIRO_FORMAT_ARGB32, W, H, W * 4); cairo_surface_write_to_png(im, "acc.png"); cairo_surface_write_to_png(g_snap, "snap.png"); }
    g_draw_ms = g_merge_ms = 0; g_merged_words = 0; g_frames = 0;
}

static void snap_done(GObject *src, GAsyncResult *res, gpointer d) {
    (void)d; GError *err = NULL;
    cairo_surface_t *s = webkit_web_view_get_snapshot_finish(WEBKIT_WEB_VIEW(src), res, &err);
    if (s) { if (g_snap) cairo_surface_destroy(g_snap); g_snap = s; compare(); }
    if (err) g_error_free(err);
    if (g_step >= g_steps) { printf("DONE badSteps %d of %d\n", g_bad_total, g_steps / 5); gtk_main_quit(); }
}
static gboolean take_snapshot(gpointer d) { (void)d; webkit_web_view_get_snapshot(g_view, WEBKIT_SNAPSHOT_REGION_VISIBLE, WEBKIT_SNAPSHOT_OPTIONS_NONE, NULL, snap_done, NULL); return FALSE; }

static gboolean step(gpointer d) {
    (void)d; g_step++;
    char js[64]; snprintf(js, sizeof js, "step(%d);document.documentElement.toggleAttribute(\"data-tn-fx\")", g_step);
    webkit_web_view_evaluate_javascript(g_view, js, -1, NULL, NULL, NULL, NULL, NULL);
    if (g_step % 5 == 0) { g_timeout_add(400, take_snapshot, NULL); return g_step < g_steps ? (g_timeout_add(900, step, NULL), FALSE) : FALSE; }
    return TRUE;
}
static gboolean start(gpointer d) { (void)d; g_timeout_add(150, step, NULL); return FALSE; }

int main(int argc, char **argv) {
    gtk_init(&argc, &argv);
    if (getenv("SW")) W = atoi(getenv("SW")); if (getenv("SH")) H = atoi(getenv("SH"));
    if (getenv("SENT")) g_sent = atoi(getenv("SENT")); if (getenv("STEPS")) g_steps = atoi(getenv("STEPS"));
    g_b = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, W, H); g_acc = calloc((size_t)W * H, 4);
    g_window = gtk_offscreen_window_new(); gtk_window_set_default_size(GTK_WINDOW(g_window), W, H);
    WebKitSettings *settings = webkit_settings_new();
    webkit_settings_set_hardware_acceleration_policy(settings, WEBKIT_HARDWARE_ACCELERATION_POLICY_NEVER);
    if (getenv("FEAT")) {
        char *spec = g_strdup(getenv("FEAT")); WebKitFeatureList *all = webkit_settings_get_all_features();
        for (char *tok = strtok(spec, ","); tok; tok = strtok(NULL, ",")) {
            char *eq = strchr(tok, '='); if (!eq) continue; *eq = 0;
            for (gsize i = 0; i < webkit_feature_list_get_length(all); i++) { WebKitFeature *f = webkit_feature_list_get(all, i);
                if (!g_strcmp0(webkit_feature_get_identifier(f), tok)) { webkit_settings_set_feature_enabled(settings, f, atoi(eq + 1)); fprintf(stderr, "feature %s=%d\n", tok, atoi(eq + 1)); } }
        }
    }
    WebKitUserContentManager *ucm = webkit_user_content_manager_new();
    { char js[48]; snprintf(js, sizeof js, "window.FORCE=%s", getenv("FORCE") ? getenv("FORCE") : "-1"); webkit_user_content_manager_add_script(ucm, webkit_user_script_new(js, WEBKIT_USER_CONTENT_INJECT_TOP_FRAME, WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, NULL, NULL)); }
    if (g_sent) webkit_user_content_manager_add_style_sheet(ucm, webkit_user_style_sheet_new(
        "html::before{content:'';position:fixed;inset:0;pointer-events:none;background:rgba(0,0,0,.004);will-change:transform;z-index:2147483647} html[data-tn-fx]::before{transform:translateX(.01px)}",
        WEBKIT_USER_CONTENT_INJECT_TOP_FRAME, WEBKIT_USER_STYLE_LEVEL_AUTHOR, NULL, NULL));
    g_view = WEBKIT_WEB_VIEW(g_object_new(WEBKIT_TYPE_WEB_VIEW, "settings", settings, "user-content-manager", ucm, NULL));
    gtk_widget_set_size_request(GTK_WIDGET(g_view), W, H);
    gtk_container_add(GTK_CONTAINER(g_window), GTK_WIDGET(g_view));
    g_signal_connect(g_window, "damage-event", G_CALLBACK(on_damage), NULL);
    GdkRGBA clear = {0, 0, 0, getenv("OPAQUE") ? 1 : 0}; webkit_web_view_set_background_color(g_view, &clear);
    gtk_widget_show_all(g_window);
    const char *page =
        "<html><body style='margin:0;background:transparent;font:28px sans-serif;color:#fff'>"
        "<div style='position:absolute;inset:0;background:linear-gradient(180deg,rgba(9,23,30,.06),transparent 35%,rgba(6,20,28,.18));box-shadow:inset 0 0 140px rgba(4,17,24,.22)'></div>"
        "<div style='position:absolute;inset:0;background:linear-gradient(90deg,rgba(5,18,25,.46),transparent 24%,transparent 86%,rgba(5,18,25,.24))'></div>"
        "<div id=root></div>"
        "<script>let seed=12345;function rnd(){seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff}"
        "const els=[];for(let i=0;i<40;i++){const e=document.createElement('div');e.style.cssText='position:absolute;padding:6px;border-radius:'+(rnd()*20|0)+'px;"
        "left:'+(rnd()*1500|0)+'px;top:'+(rnd()*900|0)+'px;width:'+(40+rnd()*200|0)+'px;height:'+(20+rnd()*100|0)+'px;background:rgba('+(rnd()*255|0)+','+(rnd()*255|0)+','+(rnd()*255|0)+','+(0.2+rnd()*0.8).toFixed(2)+');"
        "text-shadow:0 1px 4px #061217;box-shadow:0 0 '+(rnd()*20|0)+'px rgba(0,0,0,.5)';e.textContent='h'+i;root.appendChild(e);els.push(e)}"
        "function step(n){for(let k=0;k<5;k++){const e=els[(rnd()*40)|0];const m=(window.FORCE>=0 ? window.FORCE : (rnd()*4)|0);"
        "if(m==0){e.style.left=(rnd()*1500|0)+'px';e.style.top=(rnd()*900|0)+'px'}"
        "else if(m==1){e.style.visibility=e.style.visibility=='hidden'?'visible':'hidden'}"
        "else if(m==2){e.style.opacity=(rnd()).toFixed(2)}"
        "else{e.textContent='v'+n+'_'+((rnd()*1000)|0);e.style.background='rgba('+(rnd()*255|0)+','+(rnd()*255|0)+','+(rnd()*255|0)+','+(0.1+rnd()*0.9).toFixed(2)+')'}}}"
        "</script></body></html>";
    webkit_web_view_load_html(g_view, page, "file:///");
    g_timeout_add(1500, start, NULL);
    gtk_main(); return g_bad_total ? 1 : 0;
}
