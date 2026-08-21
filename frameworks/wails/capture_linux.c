#include "capture_linux.h"

#include <gtk/gtk.h>
#include <stdlib.h>
#include <string.h>

static SoksakLinuxCapture capture_failure(const char *message) {
  SoksakLinuxCapture result = {NULL, 0, strdup(message)};
  return result;
}

static double clamp(double value, double minimum, double maximum) {
  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

SoksakLinuxCapture soksakCaptureLinuxWindow(void *gtk_window, double x,
                                             double y, double width,
                                             double height) {
  if (gtk_window == NULL) return capture_failure("capture received a nil GTK window");

  GtkWidget *window = GTK_WIDGET(gtk_window);
  GtkWidget *child = gtk_window_get_child(GTK_WINDOW(window));
  if (child == NULL) return capture_failure("the GTK window has no content widget");

  int window_width = gtk_widget_get_width(window);
  int window_height = gtk_widget_get_height(window);
  if (window_width < 1 || window_height < 1) {
    return capture_failure("the GTK window has no rendered extent");
  }

  gboolean crop = width > 0 && height > 0;
  double x0 = crop ? clamp(x, 0, window_width) : 0;
  double y0 = crop ? clamp(y, 0, window_height) : 0;
  double x1 = crop ? clamp(x + width, 0, window_width) : window_width;
  double y1 = crop ? clamp(y + height, 0, window_height) : window_height;
  if (x1 - x0 < 1 || y1 - y0 < 1) {
    return capture_failure("the requested region is empty after clamping to the GTK window");
  }

  GtkSnapshot *snapshot = gtk_snapshot_new();
  gtk_widget_snapshot_child(window, child, snapshot);
  GskRenderNode *node = gtk_snapshot_free_to_node(snapshot);
  if (node == NULL) return capture_failure("the GTK window produced no render node");

  GtkNative *native = gtk_widget_get_native(window);
  GdkSurface *surface = native == NULL ? NULL : gtk_native_get_surface(native);
  if (surface == NULL) {
    gsk_render_node_unref(node);
    return capture_failure("the GTK window has no render surface");
  }

  GskRenderer *renderer = gsk_renderer_new_for_surface(surface);
  if (renderer == NULL) {
    gsk_render_node_unref(node);
    return capture_failure("GTK could not create a renderer for the window");
  }

  graphene_rect_t viewport;
  graphene_rect_init(&viewport, (float)x0, (float)y0, (float)(x1 - x0),
                     (float)(y1 - y0));
  GdkTexture *texture = gsk_renderer_render_texture(renderer, node, &viewport);
  gsk_renderer_unrealize(renderer);
  g_object_unref(renderer);
  gsk_render_node_unref(node);
  if (texture == NULL) return capture_failure("GTK produced no capture texture");

  GBytes *bytes = gdk_texture_save_to_png_bytes(texture);
  g_object_unref(texture);
  if (bytes == NULL) return capture_failure("GTK could not encode the capture as PNG");

  gsize length = 0;
  const void *data = g_bytes_get_data(bytes, &length);
  if (data == NULL || length == 0) {
    g_bytes_unref(bytes);
    return capture_failure("GTK encoded an empty capture");
  }

  unsigned char *copy = malloc(length);
  if (copy == NULL) {
    g_bytes_unref(bytes);
    return capture_failure("the capture allocation failed");
  }
  memcpy(copy, data, length);
  g_bytes_unref(bytes);
  SoksakLinuxCapture result = {copy, length, NULL};
  return result;
}

void soksakCaptureLinuxFree(SoksakLinuxCapture capture) {
  free(capture.png);
  free(capture.error);
}
