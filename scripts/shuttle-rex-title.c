// Prints the title of Rex's front window, for Shuttle.RexFocus.
//
// macOS binds an Accessibility grant to this binary's path and code hash, so
// scripts/shuttle-rex-title-install.sh never rebuilds an installed copy. The
// grant applies whoever runs it: the first exec disclaims responsibility, which
// makes this binary, and not the daemon that spawned it, the client macOS asks
// about.
//
// Exit status: 0 with the title, or nothing when Rex has no window; 3 without
// the grant; 1 on any other failure. `--prompt` shows the macOS grant dialog.

#include <ApplicationServices/ApplicationServices.h>
#include <crt_externs.h>
#include <libproc.h>
#include <mach-o/dyld.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DISCLAIMED "SHUTTLE_REX_TITLE_DISCLAIMED"
#define NOT_TRUSTED 3

int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attr, int disclaim);

static void become_responsible(char **argv) {
    char self[PROC_PIDPATHINFO_MAXSIZE];
    uint32_t size = sizeof self;
    posix_spawnattr_t attr;
    if (_NSGetExecutablePath(self, &size) != 0 || posix_spawnattr_init(&attr) != 0) exit(1);
    setenv(DISCLAIMED, "1", 1);
    responsibility_spawnattrs_setdisclaim(&attr, 1);
    posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETEXEC);
    posix_spawn(NULL, self, NULL, &attr, argv, *_NSGetEnviron());
    exit(1);
}

static pid_t rex_pid(void) {
    static pid_t pids[16384];
    static const char suffix[] = ".app/Contents/MacOS/Rex";
    size_t suffix_len = strlen(suffix);
    int count = proc_listallpids(pids, sizeof pids);
    for (int i = 0; i < count; i++) {
        char path[PROC_PIDPATHINFO_MAXSIZE];
        int len = proc_pidpath(pids[i], path, sizeof path);
        if (len >= (int)suffix_len && strcmp(path + len - suffix_len, suffix) == 0) return pids[i];
    }
    return 0;
}

static int prompt(void) {
    const void *keys[] = {kAXTrustedCheckOptionPrompt}, *values[] = {kCFBooleanTrue};
    CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                                                 &kCFTypeDictionaryValueCallBacks);
    return AXIsProcessTrustedWithOptions(options) ? 0 : NOT_TRUSTED;
}

static int print_title(void) {
    if (!AXIsProcessTrusted()) return NOT_TRUSTED;
    pid_t pid = rex_pid();
    if (pid == 0) return 0;

    CFArrayRef windows = NULL;
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, (CFTypeRef *)&windows) != kAXErrorSuccess) return 1;
    if (CFArrayGetCount(windows) == 0) return 0;

    CFStringRef title = NULL;
    char text[4096];
    if (AXUIElementCopyAttributeValue(CFArrayGetValueAtIndex(windows, 0), kAXTitleAttribute, (CFTypeRef *)&title) !=
            kAXErrorSuccess ||
        !CFStringGetCString(title, text, sizeof text, kCFStringEncodingUTF8))
        return 1;
    puts(text);
    return 0;
}

int main(int argc, char **argv) {
    if (getenv(DISCLAIMED) == NULL) become_responsible(argv);
    return argc > 1 && strcmp(argv[1], "--prompt") == 0 ? prompt() : print_title();
}
