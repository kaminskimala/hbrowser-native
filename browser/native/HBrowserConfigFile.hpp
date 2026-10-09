/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#pragma once

#include <cerrno>
#include <cstddef>
#include <cstring>
#include <optional>
#include <string>

#ifndef _WIN32
#  include <fcntl.h>
#  include <sys/stat.h>
#  include <unistd.h>
#endif

namespace hbrowser {

inline constexpr std::size_t kMaxConfigFileBytes = 1024 * 1024;

struct ConfigFileResult {
  bool requested = false;
  std::string contents;
  std::string error;
};

#ifndef _WIN32
namespace detail {
class ScopedDescriptor {
 public:
  explicit ScopedDescriptor(int descriptor) : descriptor_(descriptor) {}
  ~ScopedDescriptor() { close(descriptor_); }
  ScopedDescriptor(const ScopedDescriptor&) = delete;
  ScopedDescriptor& operator=(const ScopedDescriptor&) = delete;
  int get() const { return descriptor_; }

 private:
  int descriptor_;
};
}  // namespace detail
#endif

// A configured but invalid source is distinct from an absent source: callers
// must reject the former instead of silently switching to environment config.
inline ConfigFileResult ReadConfigFile(const std::optional<std::string>& path) {
  ConfigFileResult result;
  if (!path) return result;
  result.requested = true;
  if (path->empty() || path->find('\0') != std::string::npos) {
    result.error = "configuration file path is empty or contains a NUL byte";
    return result;
  }

#ifdef _WIN32
  result.error = "configuration files are not supported on Windows";
  return result;
#else
  // Nonblocking open avoids hanging on a FIFO before fstat rejects it. Validate
  // the opened descriptor, not a preceding stat that could race a replacement.
  int descriptor;
  do {
    descriptor = open(path->c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  } while (descriptor == -1 && errno == EINTR);
  if (descriptor == -1) {
    result.error = std::string("cannot open configuration file: ") + std::strerror(errno);
    return result;
  }
  detail::ScopedDescriptor file(descriptor);
  struct stat metadata {};
  if (fstat(file.get(), &metadata) == -1) {
    result.error = "cannot inspect configuration file";
    return result;
  }
  if (!S_ISREG(metadata.st_mode)) {
    result.error = "configuration file must be a regular file";
    return result;
  }
  if (metadata.st_uid != geteuid()) {
    result.error = "configuration file must belong to the current user";
    return result;
  }
  const mode_t permissions = metadata.st_mode & 07777;
  if (permissions != 0400 && permissions != 0600) {
    result.error = "configuration file must have private permissions 0400 or 0600";
    return result;
  }
  if (metadata.st_size < 0 ||
      static_cast<unsigned long long>(metadata.st_size) > kMaxConfigFileBytes) {
    result.error = "configuration file exceeds the 1 MiB limit";
    return result;
  }

  char buffer[4096];
  while (true) {
    const ssize_t count = read(file.get(), buffer, sizeof(buffer));
    if (count == -1 && errno == EINTR) continue;
    if (count == -1) {
      result.error = "cannot read configuration file";
      result.contents.clear();
      return result;
    }
    if (count == 0) return result;
    const auto bytes = static_cast<std::size_t>(count);
    // Also enforce the bound while reading, in case the file grows after fstat.
    if (bytes > kMaxConfigFileBytes - result.contents.size()) {
      result.error = "configuration file exceeds the 1 MiB limit";
      result.contents.clear();
      return result;
    }
    result.contents.append(buffer, bytes);
  }
#endif
}

}  // namespace hbrowser
