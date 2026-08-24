#include <gtk/gtk.h>
#include "window_native_linux.h"

void soksakShowWithoutPresent(void *window) {
    gtk_widget_set_visible(GTK_WIDGET(window), TRUE);
}

int soksakPresentCaptureOnlyWindow(void *window) {
    if (window == NULL) return 0;
    GtkWidget *widget = GTK_WIDGET(window);
    gtk_widget_set_focusable(widget, FALSE);
    gtk_widget_set_can_target(widget, FALSE);
    gtk_widget_set_opacity(widget, 0.0);
    gtk_widget_set_visible(widget, TRUE);
    return gtk_widget_get_visible(widget) ? 1 : 0;
}

int soksakWindowContentSize(void *window, double *width, double *height) {
    if (window == NULL || width == NULL || height == NULL) return 0;
    GtkWidget *child = gtk_window_get_child(GTK_WINDOW(window));
    if (child == NULL) return 0;
    int w = gtk_widget_get_width(child);
    int h = gtk_widget_get_height(child);
    if (w < 1 || h < 1) return 0;
    *width = (double)w;
    *height = (double)h;
    return 1;
}
