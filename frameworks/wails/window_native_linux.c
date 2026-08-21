#include <gtk/gtk.h>
#include "window_native_linux.h"

void soksakShowWithoutPresent(void *window) {
    gtk_widget_set_visible(GTK_WIDGET(window), TRUE);
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
