/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "MaskConfig.hpp"

#ifdef __linux__
// libxul loads before Gecko enables the Linux content sandbox. Cache config in
// each process now, so later getters never need filesystem access in a sandbox.
__attribute__((constructor)) static void HBrowserLoadPrivateConfig() {
  if (std::getenv("HBROWSER_CONFIG_FILE")) {
    (void)MaskConfig::GetJson();
  }
}
#endif
