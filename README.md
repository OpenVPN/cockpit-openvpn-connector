cockpit-openvpn-connector
=========================

This is a project which builds on
[OpenVPN Connector Setup](https://codeberg.org/OpenVPN/openvpn-connector-setup)
and the [Cockpit Project](https://cockpit-project.org/).

This project contains an add-on/package to the Cockpit web based administration
tool to easily configure the host as an
[OpenVPN Connector](https://openvpn.net/cloud-docs/connector-cockpit-user-guide/)
for [CloudConnexa™](https://openvpn.net/cloud-vpn/).

Installation
------------

This is packaged for Debian, Fedora, Red Hat Enterprise Linux/CentOS and
Ubuntu.  You need to enable the
[OpenVPN 3 software repositories](https://community.openvpn.net/openvpn/wiki/OpenVPN3Linux)
before you can install the `cockpit-openvpn-connector` package.


Manual installation
-------------------

Ensure you have the
[OpenVPN 3 Linux client](https://community.openvpn.net/openvpn/wiki/OpenVPN3Linux)
installed together with the `python3-openvpn-connector-setup` package.

Then install the [Cockpit](https://cockpit-project.org/running.html) project
and ensure it is functional.

Finally, create a folder name `~/.local/share/cockpit/`.  Copy all the
files from this directory, preserving the directory structure, to this
directory.  It might be the Cockpit services on the system will need to be
restarted.

     $ mkdir -p -m755 ~/.local/share/cockpit
     $ cp -r * ~/.local/share/cockpit/


Project details
---------------

This is an Open Source project and the code is published in three different git repositories

* [MAIN] **Codeberg**: https://codeberg.org/OpenVPN/cockpit-openvpn-connector/
* [MIRROR] *GitLab*: https://gitlab.com/openvpn/cockpit-openvpn-connector/
* [MIRROR] *GitHub*: https://github.com/OpenVPN/cockpit-openvpn-connector/

Report issues using Codeberg.

Copyright
---------
Copyright (C) OpenVPN Inc.  This program is free software: you can
redistribute it and/or modify it under the terms of the
[GNU Affero General Public License](https://www.gnu.org/licenses/agpl-3.0.html)
as published by the Free Software Foundation, version 3 License.
