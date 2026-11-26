// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Basic ERC-721 where anyone can mint by paying a fixed price; the owner sets the price and withdraws proceeds.
contract ERC721Mint {
    string public name;
    string public symbol;
    address public owner;
    uint256 public mintPrice;
    uint256 public maxSupply;
    uint256 public totalMinted;
    string public baseURI;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(string memory _name, string memory _symbol, uint256 _mintPrice, uint256 _maxSupply, string memory _baseURI) {
        name = _name;
        symbol = _symbol;
        owner = msg.sender;
        mintPrice = _mintPrice;
        maxSupply = _maxSupply;
        baseURI = _baseURI;
    }

    function mint() external payable returns (uint256 tokenId) {
        require(msg.value >= mintPrice, "insufficient payment");
        require(totalMinted < maxSupply, "sold out");
        tokenId = ++totalMinted;
        _owners[tokenId] = msg.sender;
        _balances[msg.sender] += 1;
        emit Transfer(address(0), msg.sender, tokenId);
        if (msg.value > mintPrice) {
            (bool ok, ) = msg.sender.call{value: msg.value - mintPrice}("");
            require(ok, "refund failed");
        }
    }

    function balanceOf(address who) external view returns (uint256) {
        require(who != address(0), "zero address");
        return _balances[who];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _owners[tokenId];
        require(o != address(0), "nonexistent token");
        return o;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        ownerOf(tokenId);
        return string.concat(baseURI, _toString(tokenId));
    }

    function approve(address to, uint256 tokenId) external {
        address o = ownerOf(tokenId);
        require(msg.sender == o || _operatorApprovals[o][msg.sender], "not authorized");
        _tokenApprovals[tokenId] = to;
        emit Approval(o, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        return _tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address o, address operator) external view returns (bool) {
        return _operatorApprovals[o][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        address o = ownerOf(tokenId);
        require(o == from, "wrong from");
        require(to != address(0), "zero address");
        require(msg.sender == o || _tokenApprovals[tokenId] == msg.sender || _operatorApprovals[o][msg.sender], "not authorized");
        delete _tokenApprovals[tokenId];
        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function setMintPrice(uint256 newPrice) external {
        require(msg.sender == owner, "not owner");
        mintPrice = newPrice;
    }

    function withdraw(address payable to) external {
        require(msg.sender == owner, "not owner");
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        bytes memory b = new bytes(len);
        while (v != 0) {
            b[--len] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(b);
    }
}
