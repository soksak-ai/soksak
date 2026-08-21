#include <gtk/gtk.h>
#include "window_native_linux.h"

void soksakShowWithoutPresent(void *window) {
    gtk_widget_set_visible(GTK_WIDGET(window), TRUE);
}
