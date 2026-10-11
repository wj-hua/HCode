// libuv selects fork/exec when spawn-attribute setup returns ENOSYS.
// The OS sandbox denies posix_spawn, setsid and setpgid; this library only preserves Node compatibility.
#include <errno.h>
#include <spawn.h>

static int hcode_spawn_attributes(posix_spawnattr_t *attributes, short flags) {
  (void)attributes;
  (void)flags;
  return ENOSYS;
}
__attribute__((used)) static struct {
  const void *replacement;
  const void *original;
} hcode_spawn_interpose __attribute__((section("__DATA,__interpose"))) = {
  (const void *)&hcode_spawn_attributes,
  (const void *)&posix_spawnattr_setflags
};
