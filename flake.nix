{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      pkgs = (import nixpkgs {
        system = "x86_64-linux";
      });
      python = pkgs.python3.withPackages (ps: with ps; [
        shapely
        svgpathtools
        networkx
        numpy
        scipy
        pytest
      ]);
    in
    {
      devShell.x86_64-linux = pkgs.mkShell {
        buildInputs = [
          pkgs.go
          pkgs.gopls
          pkgs.ruff
          python
        ];
      };
    };
}
