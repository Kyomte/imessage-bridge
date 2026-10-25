// The executable inside "iMessage Bridge.app".
//
// macOS grants Full Disk Access and Automation (control of Messages) to an app, and a
// child process counts as its parent's "responsible" app. So launchd starts this small
// signed launcher, and it starts node as a child: the grants attach to iMessage Bridge,
// and Homebrew can update node without invalidating them. The command is compiled in
// (see install.sh), so the launcher can't be used to run anything else with them.

#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>

#if !defined(NODE_PATH) || !defined(SCRIPT_PATH)
#error "build with -DNODE_PATH='\"/path/to/node\"' -DSCRIPT_PATH='\"/path/to/main.ts\"'"
#endif

extern char **environ;
static pid_t child = -1;

static void forward(int sig) {
  if (child > 0) kill(child, sig);
}

int main(void) {
  char *argv[] = {NODE_PATH, SCRIPT_PATH, NULL};

  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = forward;
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);

  int err = posix_spawn(&child, NODE_PATH, NULL, NULL, argv, environ);
  if (err != 0) {
    fprintf(stderr, "imessage-bridge: cannot start %s: %s\n", NODE_PATH, strerror(err));
    return 1;
  }

  int status;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) return 1;
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
