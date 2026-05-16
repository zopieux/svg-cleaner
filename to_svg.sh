#!/usr/bin/env nix-shell
#!nix-shell -i bash -p inkscape

inkscape --export-type=svg "$@"
