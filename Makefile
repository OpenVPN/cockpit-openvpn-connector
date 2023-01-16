# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2022         OpenVPN Inc <sales@openvpn.net>
# Copyright 2022         David Sommerseth <davids@openvpn.net>

DESTDIR ?=
PREFIX ?= /usr/local
datadir ?= $(PREFIX)/share
localstatedir ?= /var
sharedstatedir ?= $(localstatedir)/lib

# Define cockpit app destination directories
appname = openvpn-connector
cockpit_root := $(datadir)/cockpit
cockpit_app := $(cockpit_root)/$(appname)

# Compute list of Cockpit application files
cockpit_dirs := img css
cockpit_files := $(foreach dir, $(cockpit_dirs), $(wildcard $(dir)/*))
cockpit_files += $(wildcard *.html)
cockpit_files += $(wildcard *.js)
cockpit_files += $(wildcard *.json)

# Define polkit/PolicyKit destintation directories
polkit_pkladir := $(sharedstatedir)/polkit-1/localauthority/10-vendor.d
polkit_rulesdir := $(datadir)/polkit-1/rules.d

all :
	@echo "Nothing to build, only install"

install :
	for d in $(cockpit_dirs); do mkdir -m755 -p $(DESTDIR)$(cockpit_app)/$$d; done
	for f in $(cockpit_files); do \
		install -m644 $$f $(DESTDIR)$(cockpit_app)/$$f ; \
	done

	mkdir -m766 -p $(DESTDIR)$(polkit_pkladir) $(DESTDIR)$(polkit_rulesdir)
	for f in $(wildcard polkit/*.pkla); do \
		install -m644 $$f $(DESTDIR)$(polkit_pkladir)/ ; \
	done
	for f in $(wildcard polkit/*.rules); do \
		install -m644 $$f $(DESTDIR)$(polkit_rulesdir)/ ; \
	done
